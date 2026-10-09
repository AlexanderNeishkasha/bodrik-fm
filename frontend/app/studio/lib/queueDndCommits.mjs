import { removeTempEntry } from "./queueDndHandlerHelpers.mjs";
import { reorderQueue } from "./queueDndUtils.mjs";

/** Optimistically remove/play one queue entry and restore it on command failure. */
export async function commitQueueRemoval({
  path,
  index,
  localQueue,
  queueIds,
  setLocalQueue,
  setQueueIds,
  sendAction,
}) {
  setLocalQueue((current) => current.filter((_, itemIndex) => itemIndex !== index));
  setQueueIds((current) => current.filter((_, itemIndex) => itemIndex !== index));
  const data = await sendAction(path, { index });
  if (data) return true;
  setLocalQueue(localQueue);
  setQueueIds(queueIds);
  return false;
}

/** Replace one temporary preview with a track and remove it on insert failure. */
export async function commitTemporaryQueueInsert({
  activeId,
  tempId,
  track,
  queueIds,
  setLocalQueue,
  setQueueIds,
  sendAction,
}) {
  const insertIndex = queueIds.indexOf(tempId);
  setLocalQueue((current) => current.map((item, index) => (
    queueIds[index] === tempId ? track : item
  )));
  const data = await sendAction("/api/studio/queue/insert", {
    id: activeId,
    index: insertIndex < 0 ? queueIds.length : insertIndex,
  });
  if (data) return true;
  removeTempEntry({ tempId, queueIds, setLocalQueue, setQueueIds });
  return false;
}

/** Append one optimistic library track and remove it on insert failure. */
export async function commitAppendedQueueInsert({
  activeId,
  track,
  queueIds,
  insertedId,
  setLocalQueue,
  setQueueIds,
  sendAction,
}) {
  setLocalQueue((current) => [...current, track]);
  setQueueIds((current) => [...current, insertedId]);
  const data = await sendAction("/api/studio/queue/insert", {
    id: activeId,
    index: queueIds.length,
  });
  if (data) return true;
  removeTempEntry({
    tempId: insertedId,
    queueIds: [...queueIds, insertedId],
    setLocalQueue,
    setQueueIds,
  });
  return false;
}

/** Optimistically reorder the queue and clear suppression or restore on failure. */
export async function commitQueueReorder({
  from,
  to,
  localQueue,
  queueIds,
  setLocalQueue,
  setQueueIds,
  pendingQueueRef,
  suppressSyncUntilRef,
  sendAction,
}) {
  const nextQueue = reorderQueue(localQueue, from, to);
  setLocalQueue(nextQueue);
  setQueueIds((current) => reorderQueue(current, from, to));
  pendingQueueRef.current = nextQueue;
  suppressSyncUntilRef.current = Date.now() + 700;
  const data = await sendAction("/api/studio/queue/reorder", { from, to });
  if (data) return true;
  pendingQueueRef.current = null;
  suppressSyncUntilRef.current = 0;
  setLocalQueue(localQueue);
  setQueueIds(queueIds);
  return false;
}
