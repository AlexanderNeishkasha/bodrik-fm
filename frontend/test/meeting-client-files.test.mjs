import assert from "node:assert/strict";
import { test } from "node:test";

import { CHUNK_BYTES, createFileTransfers, decodeFrame, encodeFrame, sha256 } from "../features/meeting/client/fileTransfer.mjs";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** Fake browser file. */
function file(bytes, name = "a.bin") {
  return { name, type: "application/octet-stream", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(0) };
}

/** Transfers over a recording command/binary fake. */
function setup() {
  const commands = [];
  const frames = [];
  const completed = [];
  const transfers = createFileTransfers({
    async command(action) {
      commands.push(action);
      return action.type === "fileOffer" ? { transferId: ID, chunkBytes: CHUNK_BYTES } : {};
    },
    sendBinary: async (frame) => frames.push(frame),
    complete: (value) => completed.push(value),
  });
  let latest = [];
  transfers.observe((value) => (latest = value));
  return { transfers, commands, frames, completed, latest: () => latest };
}

test("frames round-trip and reject malformed input", () => {
  const payload = Uint8Array.from([1, 2, 3]);
  const decoded = decodeFrame(encodeFrame(ID, 7, true, payload));
  assert.deepEqual({ ...decoded, payload: [...decoded.payload] }, { transferId: ID, sequence: 7, finalChunk: true, payload: [1, 2, 3] });
  const cases = [
    ["short", new Uint8Array(10)],
    ["bad magic", (() => { const frame = encodeFrame(ID, 0, true, payload); frame[0] = 0; return frame; })()],
    ["length mismatch", encodeFrame(ID, 0, true, payload).slice(0, -1)],
  ];
  for (const [name, input] of cases) assert.throws(() => decodeFrame(input), /invalid frame/, name);
  assert.throws(() => encodeFrame(ID, 0, true, new Uint8Array(0)), /invalid chunk/);
});

test("send hashes, offers and streams chunks with the final flag on the last", async () => {
  const { transfers, commands, frames, latest } = setup();
  const bytes = new Uint8Array(CHUNK_BYTES * 2 + 5).fill(9);
  await transfers.send(file(bytes), { type: "public" });
  assert.equal(commands[0].type, "fileOffer");
  assert.equal(commands[0].offer.sha256, await sha256(bytes));
  assert.deepEqual(frames.map((frame) => [decodeFrame(frame).sequence, decodeFrame(frame).finalChunk]), [[0, false], [1, false], [2, true]]);
  assert.equal(latest()[0].transferred, bytes.byteLength);
});

test("send rejects invalid files before any command", async () => {
  const { transfers, commands } = setup();
  for (const [name, value] of [["empty", file(new Uint8Array(0))], ["bad name", file(new Uint8Array(1), "a/b")], ["missing", null]]) {
    await assert.rejects(transfers.send(value, { type: "public" }), /invalid file/, name);
  }
  assert.equal(commands.length, 0);
});

/** Feed an incoming offer plus frames for these bytes. */
async function receive(context, bytes, { hash } = {}) {
  await context.transfers.event("fileOffer", { transferId: ID, fileName: "r.bin", size: bytes.byteLength, sha256: hash ?? (await sha256(bytes)), target: { type: "public" } }, { peerName: "Bob" });
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += CHUNK_BYTES, index++) {
    const chunk = bytes.slice(offset, offset + CHUNK_BYTES);
    context.transfers.binary(encodeFrame(ID, index, offset + chunk.byteLength === bytes.byteLength, chunk));
  }
}

test("incoming files are verified before completion", async () => {
  const context = setup();
  const bytes = new Uint8Array(CHUNK_BYTES + 3).fill(4);
  await receive(context, bytes);
  await context.transfers.event("fileComplete", { transferId: ID });
  assert.deepEqual([...context.completed[0].bytes], [...bytes]);
  assert.deepEqual([context.latest()[0].phase, context.latest()[0].downloadable, context.latest()[0].peerName], ["completed", true, "Bob"]);
});

test("integrity failure and out-of-order frames fail the transfer", async () => {
  const bad = setup();
  await receive(bad, new Uint8Array(10).fill(1), { hash: "0".repeat(64) });
  await assert.rejects(bad.transfers.event("fileComplete", { transferId: ID }), /integrity/);
  assert.equal(bad.latest()[0].error, "integrity_failure");
  assert.equal(bad.completed.length, 0);

  const order = setup();
  await order.transfers.event("fileOffer", { transferId: ID, fileName: "r.bin", size: 10, sha256: "x", target: { type: "public" } });
  assert.throws(() => order.transfers.binary(encodeFrame(ID, 1, true, new Uint8Array(10))), /invalid sequence/);
  assert.equal(order.latest()[0].phase, "failed");
});

test("cancel and reset end active transfers", async () => {
  const context = setup();
  await context.transfers.event("fileOffer", { transferId: ID, fileName: "r.bin", size: 10, sha256: "x", target: { type: "private" } });
  await context.transfers.cancel(ID);
  assert.deepEqual(context.commands.at(-1), { type: "fileCancel", cancel: { version: 1, transferId: ID } });
  assert.equal(context.latest()[0].phase, "cancelled");
  await context.transfers.event("fileOffer", { transferId: ID, fileName: "r.bin", size: 10, sha256: "x", target: { type: "public" } });
  context.transfers.reset("disconnected");
  assert.deepEqual([context.latest()[0].phase, context.latest()[0].error], ["failed", "disconnected"]);
});

test("allocation preserves the chat identity while adding download access to the sender's original bytes", async () => {
  const context = setup();
  const values = [];
  context.transfers.observe((rows) => values.push(rows));
  await context.transfers.send(file(new Uint8Array([1, 2, 3])), { type: "private", stamp: { sessionId: "bob" } }, { peerId: "me", targetId: "bob" });
  const preparation = values.find((rows) => rows[0]?.phase === "preparing")[0];
  const latest = context.latest()[0];
  assert.equal(latest.messageId, preparation.messageId);
  assert.equal(latest.peerId, "me");
  assert.equal(latest.targetId, "bob");
  assert.equal(latest.id, ID);
  assert.equal(latest.downloadable, true);
  assert.deepEqual([...context.completed[0].bytes], [1, 2, 3]);
});

test("clearing admission during preparation cannot resurrect stale rows or send file commands", async () => {
  const context = setup();
  let resolve;
  const selected = { name: "slow.bin", size: 1, arrayBuffer: () => new Promise((yes) => { resolve = yes; }) };
  const pending = context.transfers.send(selected, { type: "public" });
  context.transfers.clear();
  resolve(new Uint8Array([1]).buffer);
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(context.latest(), []);
  assert.equal(context.commands.length, 0);
});

test("a cancelled download cannot finish after asynchronous integrity verification", async () => {
  let resolve;
  let verified = false;
  const bytes = new Uint8Array([1]);
  const hash = await sha256(bytes);
  const transfers = createFileTransfers({ command: async () => ({}), sendBinary: async () => {}, complete: () => { verified = true; },
    digest: () => new Promise((yes) => { resolve = yes; }) });
  await transfers.event("fileOffer", { transferId: ID, fileName: "one.bin", size: 1, sha256: hash, target: { type: "private" } });
  transfers.binary(encodeFrame(ID, 0, true, bytes));
  const pending = transfers.event("fileComplete", { transferId: ID });
  await transfers.cancel(ID);
  resolve(Uint8Array.from(hash.match(/../g), (part) => parseInt(part, 16)).buffer);
  assert.equal(await pending, false);
  assert.equal(verified, false);
  transfers.dispose();
});
