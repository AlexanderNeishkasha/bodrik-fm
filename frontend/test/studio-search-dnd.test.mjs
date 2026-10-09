import test from "node:test";
import assert from "node:assert/strict";
import createQueueDndHandlers from "../app/studio/lib/queueDndHandlers.js";

/** Build a command-spy harness without network requests or canonical library mutations. */
function harness() {
  const commands = [];
  let moves = 0;
  let tempId = null;
  let tempTrack = null;
  const tracks = [{ id: 1, filename: "Magical.mp3", section_id: 20, sort_order: 0 }, { id: 2, filename: "Magic.mp3", section_id: null, sort_order: 0 }];
  const handlers = createQueueDndHandlers({
    tracks, sections: [], queueIds: [], localQueue: [], isEditingLibrary: false,
    setActiveDrag: () => {}, setSections: () => {}, setTracks: () => { moves++; },
    applyLibraryPayload: () => {}, setLocalQueue: () => {}, setQueueIds: () => {},
    getTempQueueId: () => tempId, setTempQueueId: value => { tempId = value; },
    getTempTrack: () => tempTrack, setTempTrack: value => { tempTrack = value; },
    clearTemp: () => { tempId = null; tempTrack = null; }, nextQueueId: () => "queue-item-test",
    pendingQueueRef: { current: null }, suppressSyncUntilRef: { current: 0 },
    libraryDragSnapshotRef: { current: null }, libraryPreviewTargetRef: { current: null }, sectionDragSnapshotRef: { current: null },
    sendAction: async (path, body) => { commands.push({ path, body }); return {}; },
  });
  return { ...handlers, commands, moves: () => moves };
}

for (const target of ["library-drop", "library-loose-tracks", "library-track-2", "library-section-20", "library-section-sort-20"]) {
  test(`search-origin drag cannot mutate library at ${target}`, async () => {
    const h = harness();
    const event = { active: { id: "library-track-1", data: { current: { type: "library", id: 1, sectionId: 20, libraryReadOnly: true } } }, over: { id: target } };
    h.handleDragOver(event);
    await h.handleDragEnd(event);
    assert.deepEqual(h.commands, []);
    assert.equal(h.moves(), 0);
  });
}
for (const [target, path] of [["now-playing", "/api/studio/play"], ["queue-container", "/api/studio/queue/insert"]]) {
  test(`search-origin drag still accepts ${target}`, async () => {
    const h = harness();
    await h.handleDragEnd({ active: { id: "library-track-1", data: { current: { type: "library", id: 1, sectionId: 20, libraryReadOnly: true } } }, over: { id: target } });
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0].path, path);
    assert.equal(h.moves(), 0);
  });
}
