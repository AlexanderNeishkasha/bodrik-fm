import assert from "node:assert/strict";
import { test } from "node:test";

import { flushAndSettle, transitionName, withViewTransition } from "../features/meeting/room/cardMotion.mjs";

test("transition names are valid identifiers per card", () => {
  assert.equal(transitionName("bob:7f3a-1"), "meeting-card-bob_7f3a-1");
  assert.notEqual(transitionName("a:b"), transitionName("a"));
});

test("focus changes use a View Transition only when supported and motion is allowed", () => {
  const cases = [
    ["supported", { matchMedia: () => ({ matches: false }), document: { startViewTransition: (fn) => fn() } }, true],
    ["reduced motion", { matchMedia: () => ({ matches: true }), document: { startViewTransition: () => assert.fail("no transition") } }, false],
    ["unsupported browser", { matchMedia: () => ({ matches: false }), document: {} }, false],
  ];
  for (const [name, scope, transitioned] of cases) {
    let applied = 0;
    let flushed = false;
    withViewTransition(() => applied++, (change) => { flushed = true; change(); }, scope);
    assert.equal(applied, 1, name);
    assert.equal(flushed, transitioned, name);
  }
});

test("a skipped transition does not surface as an unhandled rejection", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const skipped = () => Promise.reject(new Error("Transition was skipped"));
  const scope = { matchMedia: () => ({ matches: false }), document: { startViewTransition: (fn) => { fn(); return { ready: skipped(), finished: skipped(), updateCallbackDone: skipped() }; } } };
  withViewTransition(() => {}, (change) => change(), scope);
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.off("unhandledRejection", onRejection);
  assert.deepEqual(rejections, []);
});

test("panel changes settle two frames after the synchronous flush", async () => {
  const frames = [];
  const events = [];
  const scope = { requestAnimationFrame: (fn) => { frames.push(fn); }, dispatchEvent: (event) => events.push(event.type) };
  let flushed = 0;
  let settled = false;
  const done = flushAndSettle((change) => { flushed++; change(); }, scope)(() => {}).then(() => { settled = true; });
  assert.equal(flushed, 1);
  assert.deepEqual(events, ["meeting-relayout"], "size-only containers re-fit synchronously");
  frames.shift()();
  await Promise.resolve();
  assert.equal(settled, false, "one frame is not enough for the re-measured grid");
  frames.shift()();
  await done;
  assert.equal(settled, true);
});

test("hidden tabs and stalled transitions still apply the change", async () => {
  const cases = [
    ["hidden tab applies directly", { visibilityState: "hidden", startViewTransition: () => assert.fail("no transition") }],
    ["transition that never runs its update", { visibilityState: "visible", startViewTransition: () => ({}) }],
  ];
  for (const [name, document] of cases) {
    let applied = 0;
    withViewTransition(() => applied++, (change) => change(), { matchMedia: () => ({ matches: false }), document, setTimeout: (fn) => fn() });
    assert.equal(applied, 1, name);
  }
});

test("no View Transition while a modal dialog is open (snapshots would cover it)", () => {
  let applied = 0;
  const document = { visibilityState: "visible", querySelector: (selector) => (selector === "dialog:modal" ? {} : null), startViewTransition: () => assert.fail("no transition") };
  withViewTransition(() => applied++, (change) => change(), { matchMedia: () => ({ matches: false }), document });
  assert.equal(applied, 1);
});
