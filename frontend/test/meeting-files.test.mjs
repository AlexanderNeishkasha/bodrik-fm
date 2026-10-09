import test from "node:test";
import assert from "node:assert/strict";
import { createFilesSource, MAX_FILE_BYTES } from "../features/meeting/files/filesModel.mjs";

/** Build an injected adapter observation fixture with replaceable admission identity. */
function fixture() {
  let session = "session:1";
  let observer = () => {};
  const commands = [];
  const source = createFilesSource({
    observe(listener) { observer = listener; listener([]); return () => { observer = () => {}; }; },
    async send(file, target) { commands.push({ type: "send", file, target }); return "transfer-1"; },
    async cancel(id) { commands.push({ type: "cancel", id }); },
    download(id) { commands.push({ type: "download", id }); },
    getSession: () => session,
    getLanguage: () => "en",
  });
  return { source, commands, observe: (values) => observer(values), replace: () => { session = "session:2"; source.refresh(); } };
}

test("file source exposes immutable metadata and delegates exact commands", async () => {
  const h = fixture();
  h.observe([{ id: "transfer-1", direction: "outgoing", phase: "transferring", name: "notes.txt", mediaType: "text/plain", size: 10, transferred: 4, public: true, downloadable: false }]);
  const snapshot = h.source.getSnapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.transfers));
  assert.deepEqual(Object.keys(snapshot.transfers[0]).sort(), ["direction", "downloadable", "error", "id", "mediaType", "messageId", "name", "peerId", "peerName", "targetId", "phase", "public", "size", "transferred"].sort());
  const file = { name: "next.txt", size: 5 };
  await h.source.send(file, { type: "public" });
  await h.source.cancel("transfer-1");
  h.source.download("transfer-1");
  assert.deepEqual(h.commands, [{ type: "send", file, target: { type: "public" } }, { type: "cancel", id: "transfer-1" }, { type: "download", id: "transfer-1" }]);
  h.source.dispose();
});

test("file source bounds rows and clears obsolete admission state", () => {
  const h = fixture();
  h.observe(Array.from({ length: 30 }, (_, index) => ({ id: `transfer-${index}`, direction: "incoming", phase: "failed", name: `file-${index}`, size: 1, transferred: 0, error: "failed" })));
  assert.equal(h.source.getSnapshot().transfers.length, 24);
  h.replace();
  assert.equal(h.source.getSnapshot().transfers.length, 0);
  h.source.dispose();
});

for (const [name, file, target] of [
  ["empty file", { name: "empty", size: 0 }, { type: "public" }],
  ["oversized file", { name: "large", size: MAX_FILE_BYTES + 1 }, { type: "public" }],
  ["invalid recipient", { name: "file", size: 1 }, { type: "private" }],
]) test(`file source rejects ${name}`, async () => {
  const h = fixture();
  await assert.rejects(h.source.send(file, target));
  assert.equal(h.commands.length, 0);
  h.source.dispose();
});
