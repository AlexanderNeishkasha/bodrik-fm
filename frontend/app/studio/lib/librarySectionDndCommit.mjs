import {
  commitLibrarySectionOrder,
  reorderLibrarySection,
} from "./libraryDndHandlers.mjs";
import {
  isLibrarySectionReorderTarget,
  isLibraryTrackTarget,
} from "./libraryDndTargets.mjs";
import {
  restoreSectionSnapshot,
  sectionOrderChanged,
} from "./queueDndHandlerHelpers.mjs";
import { isQueueDropTarget } from "./queueDndUtils.mjs";

/** Commit one library-section drop and restore its preview on failure or mismatch. */
export async function commitLibrarySectionDrop({
  active,
  overTarget,
  sections,
  setSections,
  sectionDragSnapshotRef,
  sendAction,
}) {
  const activeData = active.data.current;
  if (overTarget === "now-playing") {
    restoreSectionSnapshot({ active, sectionDragSnapshotRef, setSections });
    await sendAction("/api/studio/sections/play", { id: activeData.id });
  } else if (isQueueDropTarget(overTarget)) {
    restoreSectionSnapshot({ active, sectionDragSnapshotRef, setSections });
    await sendAction("/api/studio/sections/queue", { id: activeData.id });
  } else if (isLibrarySectionReorderTarget(overTarget)) {
    const committed = await reorderLibrarySection({
      activeData,
      overTarget,
      sections,
      setSections,
      sendAction,
    });
    if (!committed) restoreSectionSnapshot({ active, sectionDragSnapshotRef, setSections });
    sectionDragSnapshotRef.current = null;
  } else if (
    isLibraryTrackTarget(overTarget) &&
    sectionOrderChanged(sectionDragSnapshotRef.current, sections)
  ) {
    const committed = await commitLibrarySectionOrder({ sections, sendAction });
    if (!committed) restoreSectionSnapshot({ active, sectionDragSnapshotRef, setSections });
    sectionDragSnapshotRef.current = null;
  } else {
    restoreSectionSnapshot({ active, sectionDragSnapshotRef, setSections });
  }
}
