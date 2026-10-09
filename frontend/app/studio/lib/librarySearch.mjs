/** Build a literal, case-insensitive substring matcher; whitespace-only input disables search. */
function searchPattern(query, flags = "iu") {
  const needle = query.trim();
  return needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags) : null;
}

/** Filter displayed song names without mutating tracks or their category metadata. */
export function filterLibraryTracks(tracks, query, displayName) {
  const pattern = searchPattern(query);
  return tracks.filter((track) => !pattern || pattern.test(displayName(track.filename)));
}

/** Split the original name into unmatched/matched pieces, preserving case and literal characters. */
export function libraryNameParts(name, query) {
  const pattern = searchPattern(query, "giu");
  if (!pattern) return [{ text: name, matched: false }];
  const parts = [];
  let cursor = 0;
  for (const match of name.matchAll(pattern)) {
    if (match.index > cursor) parts.push({ text: name.slice(cursor, match.index), matched: false });
    parts.push({ text: match[0], matched: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < name.length || parts.length === 0) parts.push({ text: name.slice(cursor), matched: false });
  return parts;
}
