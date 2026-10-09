import assert from "node:assert/strict";
import { test } from "node:test";
import { createVideoVisibility } from "../features/meeting/client/videoVisibility.mjs";
import { observeVideoViewport } from "../features/meeting/media/videoViewport.mjs";

/** Deterministic debounce clock with cancellation. */
function fixture() {
  const timers = new Map(), calls = [];
  let id = 0;
  const visibility = createVideoVisibility({ apply: (...args) => calls.push(args), schedule: (fn) => { timers.set(++id, fn); return id; }, cancel: (key) => timers.delete(key) });
  return { visibility, timers, calls, tick: () => { for (const fn of [...timers.values()]) fn(); } };
}
for (const name of ["layout transition", "hidden then shown", "source removed", "disposed"]) {
  test(`video visibility: ${name}`, () => {
    const f = fixture();
    assert.equal(f.visibility.visible("camera"), true);
    f.visibility.set("camera", false);
    assert.deepEqual(f.calls, []);
    if (name === "layout transition") f.visibility.set("camera", true);
    if (name === "source removed") f.visibility.retain([]);
    if (name === "disposed") f.visibility.close();
    f.tick();
    if (name === "hidden then shown") {
      assert.deepEqual(f.calls, [["camera", false]]);
      f.visibility.set("camera", true);
      assert.deepEqual(f.calls.at(-1), ["camera", true]);
    } else assert.ok(f.calls.every(([, visible]) => visible));
  });
}

/** Minimal document/element event target used to exercise visibility and PiP. */
function target() {
  const listeners = new Map();
  return { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name), emit: (name) => listeners.get(name)?.(), listeners };
}
for (const name of ["offscreen", "background", "picture in picture", "local camera", "no observer"]) {
  test(`video viewport: ${name}`, () => {
    const doc = { ...target(), visibilityState: "visible" }, element = { ...target(), ownerDocument: doc }, calls = [];
    let observed, disconnected = false;
    const scope = name === "no observer" ? {} : { IntersectionObserver: class {
      constructor(callback) { observed = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    } };
    const stop = observeVideoViewport(element, { id: "camera", local: name === "local camera" }, (...args) => calls.push(args), scope);
    if (name === "offscreen") observed([{ isIntersecting: false }]);
    if (name === "background") { doc.visibilityState = "hidden"; doc.emit("visibilitychange"); }
    if (name === "picture in picture") { doc.pictureInPictureElement = element; observed([{ isIntersecting: false }]); }
    if (name === "local camera") assert.deepEqual(calls, []);
    else assert.deepEqual(calls.at(-1), ["camera", !["offscreen", "background"].includes(name)]);
    stop();
    assert.equal(doc.listeners.size, 0);
    if (observed) assert.equal(disconnected, true);
  });
}
