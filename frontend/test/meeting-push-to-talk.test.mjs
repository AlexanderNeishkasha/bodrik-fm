import assert from "node:assert/strict";
import { test } from "node:test";
import { createPushToTalk } from "../features/meeting/client/pushToTalk.mjs";

/** Event target and observable microphone fixture with injectable signaling failures. */
function fixture({ rejectResume = false } = {}) {
  const windowRef = new EventTarget();
  const documentRef = new EventTarget();
  const listeners = new Set();
  const track = { enabled: true };
  const calls = [];
  const errors = [];
  let id = "mic-1";
  const client = {
    capture: { track: () => track },
    getState: () => ({ selfId: "me", producers: { [id]: { id, participantId: "me", kind: "audio" } } }),
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    async setMicrophoneMuted(muted) {
      calls.push(muted);
      if (!muted && rejectResume) throw new Error("resume rejected");
    },
  };
  const controller = createPushToTalk({ client, windowRef, documentRef, onError: (error) => errors.push(error) });
  return {
    controller, client, windowRef, documentRef, track, calls, errors, listeners,
    replaceProducer() { id = "mic-2"; listeners.forEach((listener) => listener()); },
  };
}

/** Settle serialized commands without wall-clock sleeps. */
async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

/** Dispatch a keyboard event with the fields the owner consumes. */
function key(target, type, extra = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { code: "Space", repeat: false, ...extra });
  target.dispatchEvent(event);
  return event;
}

for (const [name, release] of [
  ["pointer release", (value) => value.controller.release("pointer")],
  ["window blur", (value) => value.windowRef.dispatchEvent(new Event("blur"))],
  ["hidden document", (value) => { value.documentRef.hidden = true; value.documentRef.dispatchEvent(new Event("visibilitychange")); }],
  ["disposal", (value) => value.controller.dispose()],
  ["producer replacement", (value) => value.replaceProducer()],
]) {
  test(`hold to talk releases safely: ${name}`, async () => {
    const value = fixture();
    await settle();
    assert.deepEqual(value.calls, [true]);
    value.controller.press("pointer");
    await settle();
    assert.equal(value.track.enabled, true);
    release(value);
    assert.equal(value.track.enabled, false, "release gates capture before signaling settles");
    await settle();
    assert.equal(value.calls.at(-1), true);
    value.controller.dispose();
  });
}

test("overlapping inputs keep transmitting until the last input releases", async () => {
  const value = fixture();
  await settle();
  value.controller.press("pointer");
  value.controller.press("keyboard");
  await settle();
  value.controller.release("pointer");
  await settle();
  assert.equal(value.calls.at(-1), false);
  value.controller.release("keyboard");
  await settle();
  assert.equal(value.calls.at(-1), true);
  value.controller.dispose();
});

test("release during pending resume cannot leave capture enabled", async () => {
  const value = fixture();
  await settle();
  let resolve;
  value.client.setMicrophoneMuted = (muted) => {
    value.calls.push(muted);
    return muted ? Promise.resolve() : new Promise((done) => { resolve = done; });
  };
  value.controller.press("pointer");
  value.controller.release("pointer");
  assert.equal(value.track.enabled, false);
  resolve();
  await settle();
  assert.equal(value.track.enabled, false);
  assert.equal(value.calls.at(-1), true);
  value.controller.dispose();
});

test("resume rejection fails muted and reports the error", async () => {
  const value = fixture({ rejectResume: true });
  await settle();
  value.controller.press("pointer");
  await settle();
  assert.equal(value.errors.length, 1);
  assert.equal(value.track.enabled, false);
  assert.equal(value.calls.at(-1), true);
  value.controller.dispose();
});

for (const [name, path] of [
  ["focused button", [{ nodeType: 1, tagName: "BUTTON" }]],
  ["button icon", [{ nodeType: 1, tagName: "SVG" }, { nodeType: 1, tagName: "BUTTON" }]],
  ["custom button", [{ nodeType: 1, tagName: "DIV", getAttribute: () => "button" }]],
]) {
  test(`Space holds PTT instead of activating ${name}`, async () => {
    const value = fixture();
    await settle();
    const composedPath = () => path;
    assert.equal(key(value.windowRef, "keydown", { composedPath }).defaultPrevented, true);
    await settle();
    assert.equal(value.track.enabled, true);
    assert.equal(key(value.windowRef, "keydown", { composedPath, repeat: true }).defaultPrevented, true);
    await settle();
    assert.deepEqual(value.calls, [true, false], "repeats do not issue another unmute");
    assert.equal(key(value.windowRef, "keyup", { composedPath }).defaultPrevented, true);
    assert.equal(value.track.enabled, false);
    await settle();
    assert.deepEqual(value.calls, [true, false, true]);
    value.controller.dispose();
    assert.equal(key(value.windowRef, "keydown", { composedPath }).defaultPrevented, false);
    await settle();
    assert.deepEqual(value.calls, [true, false, true], "disposed capture listener cannot unmute");
  });
}

test("keyboard ignores editable controls and modifiers; repeats do not start transmission and keyup survives focus change", async () => {
  const value = fixture();
  await settle();
  for (const extra of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    key(value.windowRef, "keydown", extra);
  }
  for (const element of [
    { nodeType: 1, tagName: "INPUT" },
    { nodeType: 1, tagName: "TEXTAREA" },
    { nodeType: 1, tagName: "SELECT" },
    { nodeType: 1, tagName: "DIV", isContentEditable: true },
    { nodeType: 1, tagName: "DIV", getAttribute: () => "textbox" },
  ]) {
    key(value.windowRef, "keydown", { composedPath: () => [element] });
  }
  assert.deepEqual(value.calls, [true]);
  const event = key(value.windowRef, "keydown");
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.equal(value.calls.at(-1), false);
  key(value.windowRef, "keyup", { composedPath: () => [{ nodeType: 1, tagName: "INPUT" }] });
  await settle();
  assert.equal(value.calls.at(-1), true);
  value.controller.dispose();
  assert.equal(value.listeners.size, 0);
  key(value.windowRef, "keydown");
  await settle();
  assert.equal(value.calls.at(-1), true, "disposed bindings no longer unmute");
});
