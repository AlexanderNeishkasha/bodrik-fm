const LIBRARY_TRACK_PREFIX = "library-track-";
const LIBRARY_SECTION_PREFIX = "library-section-";
const LIBRARY_SECTION_SORT_PREFIX = "library-section-sort-";
export const LIBRARY_SECTIONS_END_TARGET = "library-sections-end";
export const LIBRARY_LOOSE_TRACKS_TARGET = "library-loose-tracks";
export const LIBRARY_ROOT_TARGET = "library-drop";

/** Return whether a target identifies a rendered library track. */
export function isLibraryTrackTarget(target) {
  return typeof target === "string" && target.startsWith(LIBRARY_TRACK_PREFIX);
}

/** Return whether a target is a section body rather than its sort handle. */
export function isLibrarySectionDropTarget(target) {
  return (
    typeof target === "string" &&
    target.startsWith(LIBRARY_SECTION_PREFIX) &&
    !target.startsWith(LIBRARY_SECTION_SORT_PREFIX)
  );
}

/** Return whether a target is a section sort handle. */
export function isLibrarySectionSortTarget(target) {
  return typeof target === "string" && target.startsWith(LIBRARY_SECTION_SORT_PREFIX);
}

/** Return whether a target accepts a library track. */
export function isLibraryDropTarget(target) {
  return (
    isLibraryTrackTarget(target) ||
    isLibrarySectionDropTarget(target) ||
    isLibrarySectionSortTarget(target) ||
    target === LIBRARY_ROOT_TARGET ||
    target === LIBRARY_LOOSE_TRACKS_TARGET
  );
}

/** Return whether a target belongs to a section header/drop surface. */
export function isLibrarySectionHeaderTarget(target) {
  return isLibrarySectionDropTarget(target) || isLibrarySectionSortTarget(target);
}

/** Return whether a target accepts section reordering. */
export function isLibrarySectionReorderTarget(target) {
  return (
    isLibrarySectionSortTarget(target) ||
    isLibrarySectionDropTarget(target) ||
    target === LIBRARY_SECTIONS_END_TARGET
  );
}

/** Parse a library track target identifier. */
export function parseLibraryTrackId(target) {
  return target.slice(LIBRARY_TRACK_PREFIX.length);
}

/** Parse a nullable section body target identifier. */
export function parseLibrarySectionDropId(target) {
  const raw = target.slice(LIBRARY_SECTION_PREFIX.length);
  return raw === "none" ? null : Number(raw);
}

/** Parse a section sort target identifier. */
export function parseLibrarySectionSortId(target) {
  return Number(target.slice(LIBRARY_SECTION_SORT_PREFIX.length));
}
