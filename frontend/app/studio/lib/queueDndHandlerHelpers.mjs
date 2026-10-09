/** Remove one temporary queue preview by its rendered identity. */
export function removeTempEntry({ tempId, queueIds, setLocalQueue, setQueueIds }) {
  if (!tempId) {
    return;
  }
  setLocalQueue((prev) => prev.filter((_, index) => queueIds[index] !== tempId));
  setQueueIds((prev) => prev.filter((id) => id !== tempId));
}

/** Restore and release the pre-drag section snapshot. */
export function restoreSectionSnapshot({
  active,
  sectionDragSnapshotRef,
  setSections,
}) {
  if (active?.data?.current?.type !== "library-section") {
    return;
  }
  if (!sectionDragSnapshotRef.current) {
    return;
  }
  setSections(sectionDragSnapshotRef.current);
  sectionDragSnapshotRef.current = null;
}

/** Restore and release the pre-drag track snapshot. */
export function restoreLibrarySnapshot({ active, libraryDragSnapshotRef, setTracks }) {
  if (active?.data?.current?.type !== "library") {
    return;
  }
  if (!libraryDragSnapshotRef.current) {
    return;
  }
  setTracks(libraryDragSnapshotRef.current);
  libraryDragSnapshotRef.current = null;
}

/** Return whether a section preview differs from its captured identity order. */
export function sectionOrderChanged(snapshot, sections) {
  return (
    Array.isArray(snapshot) &&
    snapshot.length === sections.length &&
    snapshot.some((section, index) => String(section.id) !== String(sections[index]?.id))
  );
}
