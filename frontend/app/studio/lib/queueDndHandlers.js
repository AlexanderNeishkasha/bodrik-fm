import { isQueueDropTarget, isQueueItemTarget, reorderQueue } from "./queueDndUtils.mjs";
import {
  commitAppendedQueueInsert,
  commitQueueRemoval,
  commitQueueReorder,
  commitTemporaryQueueInsert,
} from "./queueDndCommits.mjs";
import {
  moveLibraryTrack,
  previewLibrarySectionReorder,
  previewLibraryTrackMove,
} from "./libraryDndHandlers.mjs";
import {
  isLibraryDropTarget,
  isLibraryTrackTarget,
} from "./libraryDndTargets.mjs";
import { commitLibrarySectionDrop } from "./librarySectionDndCommit.mjs";
import { captureDragSnapshots, restoreCancelledDrag } from "./queueDndSnapshots.mjs";
import {
  removeTempEntry,
  restoreLibrarySnapshot,
  restoreSectionSnapshot,
} from "./queueDndHandlerHelpers.mjs";
/** Coordinate DnD previews/commits and rollback; search results may export songs but never reorganize the library. */
export default function useQueueDndHandlers({
  setActiveDrag,
  sections,
  setSections,
  tracks,
  setTracks,
  applyLibraryPayload,
  isEditingLibrary,
  queueIds,
  localQueue,
  setLocalQueue,
  setQueueIds,
  getTempQueueId,
  setTempQueueId,
  getTempTrack,
  setTempTrack,
  clearTemp,
  nextQueueId,
  pendingQueueRef,
  suppressSyncUntilRef,
  libraryDragSnapshotRef,
  libraryPreviewTargetRef,
  sectionDragSnapshotRef,
  sendAction,
}) {
  /** Capture authoritative snapshots before optimistic drag previews. */
  const handleDragStart = (event) => {
    setActiveDrag(event.active);
    captureDragSnapshots({
      active: event.active,
      tracks,
      sections,
      libraryDragSnapshotRef,
      libraryPreviewTargetRef,
      sectionDragSnapshotRef,
    });
  };
  /** Preview the current drag target without issuing server commands. */
  const handleDragOver = (event) => {
    const activeData = event.active?.data?.current;
    const overTarget = event.over?.id ?? null;
    if (activeData?.type === "library-section") {
      previewLibrarySectionReorder({ activeData, overTarget, setSections });
      return;
    }
    if (activeData?.type !== "library") {
      return;
    }
    let tempId = getTempQueueId();
    if (tempId && !isQueueDropTarget(overTarget)) {
      removeTempEntry({ tempId, queueIds, setLocalQueue, setQueueIds }); clearTemp(); tempId = null;
    }
    if (activeData.libraryReadOnly && isLibraryDropTarget(overTarget)) return;
    if (isLibraryTrackTarget(overTarget) || overTarget === "library-loose-tracks") {
      const target = previewLibraryTrackMove({
        activeData,
        overTarget,
        tracks,
        setTracks,
      });
      if (target) libraryPreviewTargetRef.current = { overTarget, target };
      return;
    }
    if (isLibraryDropTarget(overTarget)) {
      libraryPreviewTargetRef.current = { overTarget, target: null };
      return;
    }
    if (isEditingLibrary) {
      return;
    }
    if (!isQueueDropTarget(overTarget)) {
      removeTempEntry({ tempId, queueIds, setLocalQueue, setQueueIds });
      clearTemp();
      return;
    }
    if (!tempId) {
      const track = tracks.find((item) => item.id === activeData.id);
      if (!track) {
        return;
      }
      tempId = nextQueueId();
      setTempQueueId(tempId);
      setTempTrack(track);
      setLocalQueue((prev) => [...prev, { ...track, __temp: true }]);
      setQueueIds((prev) => [...prev, tempId]);
    }
    const from = queueIds.indexOf(tempId);
    if (from < 0) {
      return;
    }
    let to = queueIds.length - 1;
    if (isQueueItemTarget(overTarget)) {
      const overIndex = queueIds.indexOf(overTarget);
      if (overIndex >= 0) {
        to = overIndex;
      }
    }
    if (from === to) {
      return;
    }
    setLocalQueue((prev) => reorderQueue(prev, from, to));
    setQueueIds((prev) => reorderQueue(prev, from, to));
  };
  /** Commit one drop and restore optimistic state on command failure. */
  const handleDragEnd = async (event) => {
    const { active, over } = event;
    setActiveDrag(null);
    if (!over) {
      restoreSectionSnapshot({ active, sectionDragSnapshotRef, setSections });
      restoreLibrarySnapshot({ active, libraryDragSnapshotRef, setTracks });
      removeTempEntry({
        tempId: getTempQueueId(),
        queueIds,
        setLocalQueue,
        setQueueIds,
      });
      clearTemp();
      return;
    }
    const activeData = active.data.current;
    if (!activeData) {
      return;
    }
    const overTarget = over.id;
    if (activeData.type === "library-section") {
      await commitLibrarySectionDrop({
        active,
        overTarget,
        sections,
        setSections,
        sectionDragSnapshotRef,
        sendAction,
      });
      return;
    }
    if (overTarget === "now-playing") {
      if (activeData.type === "queue") {
        await commitQueueRemoval({
          path: "/api/studio/queue/force-play",
          index: activeData.index,
          localQueue,
          queueIds,
          setLocalQueue,
          setQueueIds,
          sendAction,
        });
      } else if (activeData.type === "library") {
        restoreLibrarySnapshot({ active, libraryDragSnapshotRef, setTracks });
        libraryPreviewTargetRef.current = null;
        removeTempEntry({
          tempId: getTempQueueId(),
          queueIds,
          setLocalQueue,
          setQueueIds,
        });
        clearTemp();
        await sendAction("/api/studio/play", { id: activeData.id });
      }
      return;
    }
    if (overTarget === "library-drop" && activeData.type === "queue") {
      await commitQueueRemoval({
        path: "/api/studio/queue/remove",
        index: activeData.index,
        localQueue,
        queueIds,
        setLocalQueue,
        setQueueIds,
        sendAction,
      });
      return;
    }
    if (activeData.type === "queue") {
      const from = activeData.index;
      let to = -1;
      if (overTarget === "queue-container") {
        to = Math.max(queueIds.length - 1, 0);
      } else if (isQueueItemTarget(overTarget)) {
        to = queueIds.indexOf(overTarget);
      }
      if (to < 0 || from === to) {
        return;
      }
      await commitQueueReorder({
        from,
        to,
        localQueue,
        queueIds,
        setLocalQueue,
        setQueueIds,
        pendingQueueRef,
        suppressSyncUntilRef,
        sendAction,
      });
      return;
    }
    if (activeData.type === "library") {
      const preview = libraryPreviewTargetRef.current;
      const libraryTarget = overTarget === `library-track-${activeData.id}` ? preview?.overTarget : overTarget;
      const target = preview?.overTarget === libraryTarget ? preview.target : null;
      if (isLibraryDropTarget(libraryTarget)) {
        if (activeData.libraryReadOnly) {
          restoreLibrarySnapshot({ active, libraryDragSnapshotRef, setTracks });
          removeTempEntry({ tempId: getTempQueueId(), queueIds, setLocalQueue, setQueueIds });
          libraryPreviewTargetRef.current = null;
          clearTemp();
          return;
        }
        await moveLibraryTrack({
          activeData,
          overTarget: libraryTarget,
          target,
          tracks,
          rollbackTracks: libraryDragSnapshotRef.current ?? tracks,
          setTracks,
          applyLibraryPayload,
          sendAction,
        });
        libraryDragSnapshotRef.current = null;
        libraryPreviewTargetRef.current = null;
        clearTemp();
        return;
      }
      if (isEditingLibrary) {
        restoreLibrarySnapshot({ active, libraryDragSnapshotRef, setTracks });
        libraryPreviewTargetRef.current = null;
        removeTempEntry({ tempId: getTempQueueId(), queueIds, setLocalQueue, setQueueIds });
        clearTemp();
        return;
      }
      const tempId = getTempQueueId();
      const track = getTempTrack();
      if (tempId && track && isQueueDropTarget(overTarget)) {
        restoreLibrarySnapshot({ active, libraryDragSnapshotRef, setTracks });
        await commitTemporaryQueueInsert({
          activeId: activeData.id,
          tempId,
          track,
          queueIds,
          setLocalQueue,
          setQueueIds,
          sendAction,
        });
      } else if (!tempId && isQueueDropTarget(overTarget)) {
        restoreLibrarySnapshot({ active, libraryDragSnapshotRef, setTracks });
        const trackFallback = tracks.find((item) => item.id === activeData.id);
        if (trackFallback) {
          await commitAppendedQueueInsert({
            activeId: activeData.id,
            track: trackFallback,
            queueIds,
            insertedId: nextQueueId(),
            setLocalQueue,
            setQueueIds,
            sendAction,
          });
        }
      } else if (tempId) {
        restoreLibrarySnapshot({ active, libraryDragSnapshotRef, setTracks });
        removeTempEntry({ tempId, queueIds, setLocalQueue, setQueueIds });
      }
      clearTemp();
      libraryPreviewTargetRef.current = null;
    }
  };
  /** Restore all captured state when a drag is cancelled. */
  const handleDragCancel = () => {
    setActiveDrag(null);
    restoreCancelledDrag({
      sectionDragSnapshotRef,
      libraryDragSnapshotRef,
      libraryPreviewTargetRef,
      setSections,
      setTracks,
      tempId: getTempQueueId(),
      queueIds,
      setLocalQueue,
      setQueueIds,
      clearTemp,
    });
  };
  return {
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  };
}
