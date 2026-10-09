import test from "node:test";
import assert from "node:assert/strict";
import { libraryPresenceItems, retainLibraryExits } from "../app/studio/lib/libraryPresence.mjs";

/** Build immutable presentation fixtures, separate from canonical song data. */
function rows(keys) {
  return [...keys].map(key => Object.freeze({ key, text: key }));
}

for (const { name, before, after, exiting, order } of [
  { name: "survivors are never retiring", before: "abc", after: "abc", exiting: "", order: "abc" },
  { name: "middle departure retains its old slot", before: "abc", after: "ac", exiting: "b", order: "abc" },
  { name: "multiple departures retain order", before: "abcd", after: "d", exiting: "abc", order: "abcd" },
  { name: "new matches do not enter the exit cache", before: "a", after: "ab", exiting: "", order: "ab" },
  { name: "last departure is retained beside the empty message", before: "a", after: "m", exiting: "a", order: "am" },
]) {
  test(`library presence: ${name}`, () => {
    const previous = rows(before);
    const current = rows(after);
    const exits = retainLibraryExits([], previous, current);
    assert.equal(exits.map(item => item.key).join(""), exiting);
    const rendered = libraryPresenceItems(current, exits);
    assert.equal(rendered.map(item => item.key).join(""), order);
    assert.equal(rendered.filter(item => item.isExiting).map(item => item.key).join(""), exiting);
    assert.deepEqual(previous, rows(before));
    assert.deepEqual(current, rows(after));
  });
}

test("rapid successive departures retain positions including earlier ghosts", () => {
  const first = retainLibraryExits([], rows("abc"), rows("ac"));
  const second = retainLibraryExits(first, rows("ac"), rows("a"));
  assert.equal(libraryPresenceItems(rows("a"), second).map(item => item.key).join(""), "abc");
});

test("returning IDs cancel their retirement and use their latest canonical content", () => {
  const exits = retainLibraryExits([], rows("ab"), rows("a"));
  const current = [{ key: "a", text: "a" }, { key: "b", text: "renamed" }];
  assert.deepEqual(retainLibraryExits(exits, rows("a"), current), []);
  assert.equal(libraryPresenceItems(current, exits)[1].text, "renamed");
  assert.equal(libraryPresenceItems(current, exits)[1].isExiting, false);
});

test("unchanged retiring entries preserve cache identity", () => {
  const current = rows("a");
  const exits = retainLibraryExits([], rows("ab"), current);
  assert.equal(retainLibraryExits(exits, current, current), exits);
});
