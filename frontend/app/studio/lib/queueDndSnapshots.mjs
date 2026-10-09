import { removeTempEntry } from "./queueDndHandlerHelpers.mjs";

/** Capture library/section state before optimistic drag previews. */
export function captureDragSnapshots({
  active,
  tracks,
  sections,
  libraryDragSnapshotRef,
  libraryPreviewTargetRef,
  sectionDragSnapshotRef,
}) {
  if (active?.data?.current?.type === "library") {
    libraryDragSnapshotRef.current = tracks;
    libraryPreviewTargetRef.current = null;
  }
  if (active?.data?.current?.type === "library-section") {
    sectionDragSnapshotRef.current = sections;
  }
}

/** Restore every captured preview and temporary queue entry after cancellation. */
export function restoreCancelledDrag({
  sectionDragSnapshotRef,
  libraryDragSnapshotRef,
  libraryPreviewTargetRef,
  setSections,
  setTracks,
  tempId,
  queueIds,
  setLocalQueue,
  setQueueIds,
  clearTemp,
}) {
  if (sectionDragSnapshotRef.current) {
    setSections(sectionDragSnapshotRef.current);
    sectionDragSnapshotRef.current = null;
  }
  if (libraryDragSnapshotRef.current) {
    setTracks(libraryDragSnapshotRef.current);
    libraryDragSnapshotRef.current = null;
  }
  libraryPreviewTargetRef.current = null;
  removeTempEntry({ tempId, queueIds, setLocalQueue, setQueueIds });
  clearTemp();
}
