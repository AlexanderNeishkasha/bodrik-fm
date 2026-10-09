import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttachmentReads } from "../features/meeting/client/attachmentReads.mjs";

/** Allow completion handlers and bounded queue scheduling to settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("attachment reads bound concurrency and cancelled waiters never reach the transport", async () => {
  const started = [];
  const complete = [];
  const reads = createAttachmentReads((id) => new Promise((resolve) => { started.push(id); complete.push(resolve); }), 2);
  const a = reads.read("a"); const b = reads.read("b");
  const cancel = new AbortController();
  const c = reads.read("c", { signal: cancel.signal });
  const rejected = assert.rejects(c, /cancelled/);
  const d = reads.read("d");
  await settle();
  assert.deepEqual(started, ["a", "b"]);
  cancel.abort(); await rejected;
  complete.shift()("a"); await a; await settle();
  assert.deepEqual(started, ["a", "b", "d"]);
  complete.shift()("b"); complete.shift()("d");
  assert.deepEqual(await Promise.all([b,d]), ["b","d"]);
  reads.dispose();
});

test("disposing attachment reads aborts active work and rejects queued/new requests", async () => {
  let observed;
  const reads = createAttachmentReads((_id, { signal }) => { observed = signal; return new Promise(() => {}); }, 1);
  const a = reads.read("a"); const b = reads.read("b");
  const rejected = Promise.all([assert.rejects(a, /cancelled/), assert.rejects(b, /cancelled/)]);
  await settle(); reads.dispose(); await rejected;
  assert.equal(observed.aborted, true);
  await assert.rejects(reads.read("c"), /unavailable/);
});
