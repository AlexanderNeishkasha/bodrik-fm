import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoomTheme } from "../features/meeting/client/theme.mjs";

/** Minimal room-theme stream and browser storage with observable writes. */
function setup(initial, blocked = false) {
  let socket;
  const writes = [];
  const storage = {
    getItem() { if (blocked) throw new Error("blocked"); return initial; },
    setItem(key, value) { if (blocked) throw new Error("blocked"); writes.push([key, value]); },
  };
  /** Deliver deterministic public room messages without a network connection. */
  class Socket {
    constructor() { socket = this; }
    close() { this.onclose?.(); }
  }
  const source = createRoomTheme({ slug: "room", storage, WebSocketImpl: Socket, location: { protocol: "https:", host: "meeting.test" } });
  let notifications = 0;
  source.subscribe(() => notifications++);
  return { source, writes, send: value => socket.onmessage({ data: JSON.stringify(value) }), count: () => notifications };
}

for (const [name, saved, expected, blocked] of [
  ["saved selection", "midnight", "midnight", false],
  ["no saved theme", null, "mono", false],
  ["unknown saved theme", "unknown", "mono", false],
  ["blocked storage", "midnight", "mono", true],
]) {
  test(`room theme startup: ${name}`, () => {
    const { source, send, writes, count } = setup(saved, blocked);
    assert.equal(source.getSnapshot(), expected);
    send({ theme: "aurora" });
    assert.equal(source.getSnapshot(), "aurora");
    assert.equal(count(), 1);
    assert.deepEqual(writes, blocked ? [] : [["bodrik_fm_theme", "aurora"]]);
    source.stop();
  });
}

test("unchanged room themes avoid storage writes; malformed themes cannot overwrite the cache", () => {
  const { source, send, writes, count } = setup("midnight");
  for (const value of [{ theme: "unknown" }, { theme: null }, {}]) send(value);
  assert.deepEqual(writes, []);
  assert.equal(source.getSnapshot(), "midnight");
  send({ theme: "midnight" });
  assert.deepEqual(writes, []);
  assert.equal(count(), 0);
  source.stop();
});
