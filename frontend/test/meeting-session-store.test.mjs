import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionStore } from "../features/meeting/room/meetingSessionStore.mjs";

/** Store over a fake session factory, manual scheduling and an event target. */
function setup() {
  const created = [];
  const scheduled = [];
  const target = new EventTarget();
  const store = createSessionStore("room", "https://x.test", {
    create(slug, origin) {
      const session = { slug, origin, left: 0, options: [], leave(options) { this.left += 1; this.options.push(options); } };
      created.push(session);
      return session;
    },
    schedule: (fn) => scheduled.push(fn),
    target,
  });
  const flush = () => scheduled.splice(0).forEach((fn) => fn());
  return { store, created, flush, target };
}

test("first subscribe creates exactly one session", () => {
  const { store, created } = setup();
  assert.equal(store.getSnapshot(), null);
  store.subscribe(() => {});
  store.subscribe(() => {});
  assert.equal(created.length, 1);
  assert.equal(store.getSnapshot(), created[0]);
  assert.deepEqual([created[0].slug, created[0].origin], ["room", "https://x.test"]);
});

test("a Strict Mode unsubscribe/resubscribe keeps the session", () => {
  const { store, created, flush } = setup();
  const off = store.subscribe(() => {});
  off();
  store.subscribe(() => {});
  flush();
  assert.equal(created[0].left, 0);
  assert.equal(created.length, 1);
});

test("the last unsubscribe leaves explicitly; pagehide leaves without notifying", () => {
  const unmount = setup();
  const off = unmount.store.subscribe(() => {});
  off();
  unmount.flush();
  assert.equal(unmount.created[0].left, 1);
  assert.deepEqual(unmount.created[0].options, [undefined], "explicit leave");

  const hidden = setup();
  hidden.store.subscribe(() => {});
  hidden.target.dispatchEvent(new Event("pagehide"));
  assert.equal(hidden.created[0].left, 1);
  assert.deepEqual(hidden.created[0].options, [{ notify: false }], "unload keeps the session for takeover");
});

test("restart releases the old session, ignores duplicate clicks and joins fresh", async () => {
  const created = [];
  let finish;
  const closing = new Promise(resolve => { finish = resolve; });
  const store = createSessionStore("room", "https://x.test", {
    target: new EventTarget(),
    create() {
      const session = { leave: () => closing, client: { join: async choice => { session.choice = choice; } } };
      created.push(session);
      return session;
    },
  });
  let notified = 0;
  store.subscribe(() => { notified++; });
  const choice = { name: "Name", avatar: "", audio: false, video: true };
  const first = store.restart(choice);
  await store.restart(choice);
  assert.equal(created.length, 1);
  finish();
  await first;
  assert.equal(created.length, 2);
  assert.equal(store.getSnapshot(), created[1]);
  assert.deepEqual(created[1].choice, choice);
  assert.ok(notified > 0);
});

test("pagehide cancels a restart while the previous session is closing", async () => {
  let finish;
  let created = 0;
  const target = new EventTarget();
  const closing = new Promise(resolve => { finish = resolve; });
  const store = createSessionStore("room", "https://x.test", { target, create: () => { created++; return { leave: () => closing, client: {} }; } });
  store.subscribe(() => {});
  const restarting = store.restart({ name: "Name" });
  target.dispatchEvent(new Event("pagehide"));
  finish();
  await restarting;
  assert.equal(created, 1);
});
