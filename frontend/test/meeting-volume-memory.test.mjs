import assert from "node:assert/strict";
import { test } from "node:test";
import { createLayout } from "../features/meeting/client/layout.mjs";

for (const [name, id, person] of [
  ["participant with a new session", "old", { name: "Alice" }],
  ["music bot", "bodrik-music", { bot: true }],
]) {
  test(`volume memory: ${name}`, () => {
    const values = new Map();
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
    const first = createLayout({ storage, slug: "room" });
    first.retain([id], { [id]: person });
    first.setVolume(id, 35);
    first.retain([]);
    const nextId = person.bot ? id : "new";
    const second = createLayout({ storage, slug: "room" });
    second.retain([nextId], { [nextId]: person });
    assert.equal(second.gain(nextId), 0.35);
    const other = createLayout({ storage, slug: "other-room" });
    other.retain([nextId], { [nextId]: person });
    assert.equal(other.gain(nextId), 1);
    second.setVolume(nextId, 0);
    second.retain([nextId], { [nextId]: person });
    assert.equal(second.gain(nextId), 0);
  });
}
for (const [name, raw] of [["malformed", "{"], ["invalid values", '{"person:Alice":101}']]) {
  test(`volume memory ignores ${name}`, () => {
    const layout = createLayout({ storage: { getItem: () => raw, setItem() { throw new Error("blocked"); } } });
    layout.retain(["a"], { a: { name: "Alice" } });
    assert.equal(layout.gain("a"), 1);
    layout.setVolume("a", 20);
    assert.equal(layout.gain("a"), 0.2);
  });
}
