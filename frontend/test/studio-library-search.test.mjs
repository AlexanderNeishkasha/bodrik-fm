import test from "node:test";
import assert from "node:assert/strict";
import { libraryNameParts, filterLibraryTracks } from "../app/studio/lib/librarySearch.mjs";
import { displayName } from "../app/studio/lib/format.js";

const tracks = [
  { id: 1, filename: "Battle in the Forest.mp3", section_id: 10, sort_order: 2 },
  { id: 2, filename: "Quiet forest.flac", section_id: null, sort_order: 0 },
  { id: 3, filename: "Песня о ЛЕСЕ.ogg", section_id: 20, sort_order: 1 },
  { id: 4, filename: "Night.mp3", section_id: 10, sort_order: 0 },
];

for (const { name, query, ids } of [
  { name: "middle substring across categorized and loose tracks", query: "forest", ids: [1, 2] },
  { name: "case-insensitive Latin", query: "BATTLE", ids: [1] },
  { name: "case-insensitive Cyrillic", query: "лесе", ids: [3] },
  { name: "trims surrounding whitespace", query: "  NIGHT  ", ids: [4] },
  { name: "matches the end of a name", query: "rest", ids: [1, 2] },
  { name: "empty search retains every track", query: "", ids: [1, 2, 3, 4] },
  { name: "whitespace search retains every track", query: " \t ", ids: [1, 2, 3, 4] },
  { name: "no match", query: "missing", ids: [] },
  { name: "regex punctuation is literal", query: ".*", ids: [] },
  { name: "does not match hidden filename extensions", query: ".mp3", ids: [] },
]) {
  test(`library search: ${name}`, () => {
    const before = structuredClone(tracks);
    const result = filterLibraryTracks(tracks, query, displayName);
    assert.deepEqual(result.map((track) => track.id), ids);
    assert.deepEqual(tracks, before);
    for (const track of result) assert.equal(track, tracks.find((item) => item.id === track.id));
  });
}

test("library search: empty library has no matches", () => {
  assert.deepEqual(filterLibraryTracks([], "song", displayName), []);
});

test("library search: derives matches from the latest canonical track list", () => {
  const updated = [...tracks, { id: 5, filename: "Forest rain.wav", section_id: 20 }];
  assert.deepEqual(filterLibraryTracks(updated, "forest", displayName).map((track) => track.id), [1, 2, 5]);
});

for (const { name, value, query, matches } of [
  { name: "middle and original capitalization", value: "Quiet Forest", query: "FOREST", matches: ["Forest"] },
  { name: "all repeated occurrences", value: "Forest forest FOREST", query: "forest", matches: ["Forest", "forest", "FOREST"] },
  { name: "adjacent occurrences", value: "aaaa", query: "aa", matches: ["aa", "aa"] },
  { name: "literal brackets", value: "Song [live]", query: "[live]", matches: ["[live]"] },
  { name: "literal regexp symbols", value: "Song .*", query: ".*", matches: [".*"] },
  { name: "Cyrillic", value: "Песня о ЛЕСЕ", query: "лесе", matches: ["ЛЕСЕ"] },
  { name: "Unicode emoji", value: "Night 🎵 melody", query: "🎵", matches: ["🎵"] },
  { name: "trimmed query", value: "Night", query: "  night  ", matches: ["Night"] },
  { name: "no match", value: "Night", query: "day", matches: [] },
  { name: "cleared query", value: "Night", query: "", matches: [] },
  { name: "whitespace query", value: "Night", query: "  ", matches: [] },
  { name: "empty name", value: "", query: "day", matches: [] },
]) {
  test(`library highlights: ${name}`, () => {
    const parts = libraryNameParts(value, query);
    assert.equal(parts.map(part => part.text).join(""), value);
    assert.deepEqual(parts.filter(part => part.matched).map(part => part.text), matches);
  });
}
