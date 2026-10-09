import assert from "node:assert/strict";
import { test } from "node:test";
import {
  moveLibraryTrack,
  previewLibraryTrackMove,
  reorderLibrarySection,
} from "../app/studio/lib/libraryDndHandlers.mjs";
import {
  commitAppendedQueueInsert,
  commitQueueRemoval,
  commitQueueReorder,
} from "../app/studio/lib/queueDndCommits.mjs";
import {
  buildQueueKeys,
  isQueueDropTarget,
  queueSignature,
  reorderQueue,
} from "../app/studio/lib/queueDndUtils.mjs";

test("queue identities distinguish duplicate tracks and reorder exact positions", () => {
  const queue = [{ filename: "a.mp3" }, { filename: "a.mp3" }, { filename: "b.mp3" }];
  assert.deepEqual(buildQueueKeys(queue), ["a.mp3::1", "a.mp3::2", "b.mp3::1"]);
  assert.equal(queueSignature(queue), "a.mp3||a.mp3||b.mp3");
  assert.deepEqual(reorderQueue(queue, 0, 2), [queue[1], queue[2], queue[0]]);
  assert.equal(isQueueDropTarget("queue-container"), true);
  assert.equal(isQueueDropTarget("queue-item-2"), true);
  assert.equal(isQueueDropTarget("library-drop"), false);
});

test("failed queue removal and reorder restore their authoritative snapshots", async () => {
  const queue = [{ id: 1 }, { id: 2 }];
  const ids = ["queue-item-1", "queue-item-2"];
  let renderedQueue = queue;
  let renderedIds = ids;
  const setters = {
    setLocalQueue: (value) => {
      renderedQueue = typeof value === "function" ? value(renderedQueue) : value;
    },
    setQueueIds: (value) => {
      renderedIds = typeof value === "function" ? value(renderedIds) : value;
    },
  };
  assert.equal(await commitQueueRemoval({
    path: "/remove",
    index: 0,
    localQueue: queue,
    queueIds: ids,
    ...setters,
    sendAction: async () => null,
  }), false);
  assert.equal(renderedQueue, queue);
  assert.equal(renderedIds, ids);

  const pendingQueueRef = { current: null };
  const suppressSyncUntilRef = { current: 0 };
  assert.equal(await commitQueueReorder({
    from: 0,
    to: 1,
    localQueue: queue,
    queueIds: ids,
    ...setters,
    pendingQueueRef,
    suppressSyncUntilRef,
    sendAction: async () => null,
  }), false);
  assert.equal(renderedQueue, queue);
  assert.equal(renderedIds, ids);
  assert.equal(pendingQueueRef.current, null);
  assert.equal(suppressSyncUntilRef.current, 0);
});

test("failed appended queue insertion removes its optimistic identity", async () => {
  const queue = [{ id: 1 }];
  const ids = ["queue-item-1"];
  let renderedQueue = queue;
  let renderedIds = ids;
  const committed = await commitAppendedQueueInsert({
    activeId: 2,
    track: { id: 2 },
    queueIds: ids,
    insertedId: "queue-item-2",
    setLocalQueue: (value) => {
      renderedQueue = typeof value === "function" ? value(renderedQueue) : value;
    },
    setQueueIds: (value) => {
      renderedIds = typeof value === "function" ? value(renderedIds) : value;
    },
    sendAction: async () => null,
  });
  assert.equal(committed, false);
  assert.deepEqual(renderedQueue, queue);
  assert.deepEqual(renderedIds, ids);
});

test("library track preview moves only the selected track into its target section", () => {
  const tracks = [
    { id: 1, section_id: 10, sort_order: 0, filename: "a" },
    { id: 2, section_id: 10, sort_order: 1, filename: "b" },
    { id: 3, section_id: 20, sort_order: 0, filename: "c" },
  ];
  let preview = tracks;
  const target = previewLibraryTrackMove({
    activeData: { id: 2 },
    overTarget: "library-track-3",
    tracks,
    setTracks: (next) => {
      preview = next;
    },
  });
  assert.deepEqual(target, { sectionId: 20, index: 0 });
  assert.deepEqual(preview.map(({ id, section_id, sort_order }) => ({ id, section_id, sort_order })), [
    { id: 1, section_id: 10, sort_order: 0 },
    { id: 2, section_id: 20, sort_order: 0 },
    { id: 3, section_id: 20, sort_order: 1 },
  ]);
});

test("failed library move restores the pre-drag snapshot", async () => {
  const original = [{ id: 1, section_id: null, sort_order: 0, filename: "a" }];
  const preview = [{ ...original[0], section_id: 2 }];
  let rendered = preview;
  const committed = await moveLibraryTrack({
    activeData: { id: 1 },
    overTarget: "library-section-2",
    target: { sectionId: 2, index: 0 },
    tracks: preview,
    rollbackTracks: original,
    setTracks: (next) => {
      rendered = next;
    },
    applyLibraryPayload: () => assert.fail("failed move must not apply a payload"),
    sendAction: async () => null,
  });
  assert.equal(committed, false);
  assert.equal(rendered, original);
});

test("section reorder reports command failure for caller rollback", async () => {
  const sections = [{ id: 1 }, { id: 2 }];
  let rendered = sections;
  const committed = await reorderLibrarySection({
    activeData: { id: 1 },
    overTarget: "library-section-sort-2",
    sections,
    setSections: (next) => {
      rendered = next;
    },
    sendAction: async () => null,
  });
  assert.equal(committed, false);
  assert.deepEqual(rendered.map((section) => section.id), [2, 1]);
});
