import { reorderQueue } from "./queueDndUtils.mjs";
import {
  isLibraryDropTarget,
  isLibrarySectionDropTarget,
  isLibrarySectionReorderTarget,
  isLibrarySectionSortTarget,
  isLibraryTrackTarget,
  LIBRARY_LOOSE_TRACKS_TARGET,
  LIBRARY_ROOT_TARGET,
  LIBRARY_SECTIONS_END_TARGET,
  parseLibrarySectionDropId,
  parseLibrarySectionSortId,
  parseLibraryTrackId,
} from "./libraryDndTargets.mjs";

export {
  isLibraryDropTarget,
  isLibrarySectionHeaderTarget,
  LIBRARY_LOOSE_TRACKS_TARGET,
  LIBRARY_SECTIONS_END_TARGET,
} from "./libraryDndTargets.mjs";

/** Persist one optimistic section order and report command success. */
export async function reorderLibrarySection({
  activeData,
  overTarget,
  sections,
  setSections,
  sendAction,
}) {
  const next = buildSectionReorder({ activeData, overTarget, sections });
  if (!next) {
    if (!isLibrarySectionReorderTarget(overTarget)) {
      return false;
    }
    const data = await sendAction("/api/studio/sections/reorder", {
      ids: sections.map((section) => section.id),
    });
    return data != null;
  }
  setSections(next);
  const data = await sendAction("/api/studio/sections/reorder", {
    ids: next.map((section) => section.id),
  });
  return data != null;
}

/** Persist a previewed section order and report command success. */
export async function commitLibrarySectionOrder({ sections, sendAction }) {
  const data = await sendAction("/api/studio/sections/reorder", {
    ids: sections.map((section) => section.id),
  });
  return data != null;
}

/** Preview a section reorder without persisting it. */
export function previewLibrarySectionReorder({
  activeData,
  overTarget,
  setSections,
}) {
  setSections((current) => {
    const next = buildSectionReorder({ activeData, overTarget, sections: current });
    if (!next || sameIds(current, next)) {
      return current;
    }
    return next;
  });
}

/** Build one normalized section order for a valid target. */
function buildSectionReorder({ activeData, overTarget, sections }) {
  if (
    !isLibrarySectionReorderTarget(overTarget)
  ) {
    return null;
  }
  const from = sections.findIndex((section) => String(section.id) === String(activeData.id));
  const to = resolveSectionTargetIndex({ overTarget, sections });
  if (from < 0 || to < 0 || from === to) {
    return sections;
  }
  const next = reorderQueue(sections, from, to).map((section, index) => ({
    ...section,
    sort_order: index,
  }));
  return next;
}

/** Compare section identity order without relying on object identity. */
function sameIds(left, right) {
  return (
    left.length === right.length &&
    left.every((section, index) => String(section.id) === String(right[index]?.id))
  );
}

/** Resolve a section DnD target into its current list index. */
function resolveSectionTargetIndex({ overTarget, sections }) {
  if (overTarget === LIBRARY_SECTIONS_END_TARGET) {
    return sections.length - 1;
  }
  const overId = isLibrarySectionSortTarget(overTarget)
    ? parseLibrarySectionSortId(overTarget)
    : parseLibrarySectionDropId(overTarget);
  if (overId == null) {
    return -1;
  }
  return sections.findIndex((section) => String(section.id) === String(overId));
}

/** Persist one optimistic track move and restore the prior list on failure. */
export async function moveLibraryTrack({
  activeData,
  overTarget,
  target,
  tracks,
  rollbackTracks = tracks,
  setTracks,
  applyLibraryPayload,
  sendAction,
}) {
  const resolvedTarget = target ?? previewLibraryTrackMove({
    activeData,
    overTarget,
    tracks,
    setTracks,
  });
  if (!resolvedTarget) {
    return;
  }
  const data = await sendAction("/api/studio/tracks/move", {
    track_id: Number(activeData.id),
    section_id: resolvedTarget.sectionId == null ? null : Number(resolvedTarget.sectionId),
    index: resolvedTarget.index,
  });
  if (!data) {
    setTracks(rollbackTracks);
    return false;
  }
  applyLibraryPayload?.(data);
  return true;
}

/** Preview one track placement and return its persisted target coordinates. */
export function previewLibraryTrackMove({
  activeData,
  overTarget,
  tracks,
  setTracks,
}) {
  const track = tracks.find((item) => String(item.id) === String(activeData.id));
  if (!track) {
    return null;
  }
  if (isLibraryTrackTarget(overTarget)) {
    const overTrackId = parseLibraryTrackId(overTarget);
    if (String(overTrackId) === String(activeData.id)) {
      return null;
    }
  }
  const target = resolveLibraryTarget({ overTarget, tracks });
  if (!target) {
    return null;
  }
  const next = buildMovedTracks({
    tracks,
    track,
    targetSectionId: target.sectionId,
    targetIndex: target.index,
  });
  if (!sameTrackPlacement(tracks, next)) {
    setTracks(next);
  }
  return target;
}


/** Resolve a track target into section identity and insertion index. */
function resolveLibraryTarget({ overTarget, tracks }) {
  if (overTarget === LIBRARY_ROOT_TARGET || overTarget === LIBRARY_LOOSE_TRACKS_TARGET) {
    return {
      sectionId: null,
      index: tracks.filter((track) => sameSection(track.section_id, null)).length,
    };
  }
  if (isLibrarySectionDropTarget(overTarget)) {
    const sectionId = parseLibrarySectionDropId(overTarget);
    return {
      sectionId,
      index: tracks.filter((track) => sameSection(track.section_id, sectionId)).length,
    };
  }
  if (isLibrarySectionSortTarget(overTarget)) {
    const sectionId = parseLibrarySectionSortId(overTarget);
    return {
      sectionId,
      index: tracks.filter((track) => sameSection(track.section_id, sectionId)).length,
    };
  }
  if (!isLibraryTrackTarget(overTarget)) {
    return null;
  }
  const overTrackId = parseLibraryTrackId(overTarget);
  const overTrack = tracks.find((track) => String(track.id) === String(overTrackId));
  if (!overTrack) {
    return null;
  }
  const sectionId = overTrack.section_id ?? null;
  return {
    sectionId,
    index: sortedSectionTracks(tracks, sectionId).findIndex(
      (track) => String(track.id) === String(overTrackId)
    ),
  };
}

/** Build normalized source/target section ordering for one moved track. */
function buildMovedTracks({ tracks, track, targetSectionId, targetIndex }) {
  const sourceSectionId = track.section_id ?? null;
  const sourceIds = sortedSectionTracks(tracks, sourceSectionId)
    .map((item) => item.id)
    .filter((id) => String(id) !== String(track.id));
  const targetIds = sortedSectionTracks(tracks, targetSectionId)
    .map((item) => item.id)
    .filter((id) => String(id) !== String(track.id));
  targetIds.splice(Math.min(targetIndex, targetIds.length), 0, track.id);

  const updates = new Map();
  if (!sameSection(sourceSectionId, targetSectionId)) {
    sourceIds.forEach((id, index) =>
      updates.set(String(id), { section_id: sourceSectionId, sort_order: index })
    );
  }
  targetIds.forEach((id, index) =>
    updates.set(String(id), { section_id: targetSectionId, sort_order: index })
  );

  return tracks
    .map((item) => {
      const update = updates.get(String(item.id));
      return update ? { ...item, ...update } : item;
    })
    .sort((a, b) => {
      const sectionA = a.section_id == null ? "" : String(a.section_id);
      const sectionB = b.section_id == null ? "" : String(b.section_id);
      return (
        sectionA.localeCompare(sectionB) ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        String(a.filename ?? "").localeCompare(String(b.filename ?? ""))
      );
    });
}

/** Return one section's tracks in deterministic persisted order. */
function sortedSectionTracks(tracks, sectionId) {
  return tracks
    .filter((track) => sameSection(track.section_id, sectionId))
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        String(a.filename ?? "").localeCompare(String(b.filename ?? ""))
    );
}

/** Compare nullable section identities. */
function sameSection(left, right) {
  return String(left ?? "none") === String(right ?? "none");
}

/** Compare track identity, section and order across two lists. */
function sameTrackPlacement(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (track, index) =>
        String(track.id) === String(right[index]?.id) &&
        sameSection(track.section_id, right[index]?.section_id) &&
        (track.sort_order ?? 0) === (right[index]?.sort_order ?? 0)
    )
  );
}
