import assert from "node:assert/strict";
import { test } from "node:test";

import { RECONNECT_DELAYS_MS, createMeetingSession } from "../features/meeting/client/session.mjs";

/** Minimal fake WebSocket that records sent frames and lets tests push server frames. */
class FakeSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatch("open", {});
    });
  }
  addEventListener(name, listener) {
    (this.listeners[name] ||= []).push(listener);
  }
  dispatch(name, event) {
    for (const listener of this.listeners[name] || []) listener(event);
  }
  send(frame) {
    this.sent.push(typeof frame === "string" ? JSON.parse(frame) : frame);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close", {});
  }
  server(frame) {
    this.dispatch("message", { data: JSON.stringify(frame) });
  }
}

const stamp = { roomInstanceId: "r", sessionId: "s1", admissionEpoch: 1 };

/** Manual timers so recovery and timeouts run without waiting. */
function manualTimers() {
  const timers = new Set();
  return {
    setTimer(fn, ms) {
      const timer = { fn, ms };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    /** Run every timer with exactly this delay. */
    fire(ms) {
      for (const timer of [...timers]) if (timer.ms === ms) {
        timers.delete(timer);
        timer.fn();
      }
    },
  };
}

/** Create a session with fakes and capture its messages. */
function setup(random = () => 1) {
  FakeSocket.instances = [];
  const messages = [];
  const timers = manualTimers();
  const session = createMeetingSession({
    url: "wss://x/ws/meeting/v1/room",
    ownerProof: "a".repeat(64),
    ticketProvider: async () => "ticket-1",
    onMessage: (message) => messages.push(message),
    WebSocketImpl: FakeSocket,
    ...timers,
    random,
  });
  return { session, messages, timers, socket: () => FakeSocket.instances.at(-1) };
}

/** Let queued microtasks (fake open, awaits) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Connect and deliver a welcome. */
async function admitted(context, overrides = {}) {
  const connecting = context.session.connect();
  await flush();
  context.socket().server({ type: "welcome", version: 1, stamp, recoveryToken: "rt1", revision: 0, phase: "admitted", presenter: false, ...overrides });
  await connecting;
}

test("admission sends ticket and owner proof and resolves on welcome", async () => {
  const context = setup();
  await admitted(context);
  assert.deepEqual(context.socket().sent[0], { type: "admit", version: 1, ticket: "ticket-1", ownerProof: "a".repeat(64) });
  assert.equal(context.session.sessionId, "s1");
  assert.ok(context.messages.some((message) => message.type === "welcome"));
});

test("admission error frames reject with the server code", async () => {
  const context = setup();
  const connecting = context.session.connect();
  await flush();
  context.socket().server({ type: "error", code: "revoked" });
  await assert.rejects(connecting, (error) => error.code === "revoked");
});

test("commands are sequenced and resolve or reject by result", async () => {
  const context = setup();
  await admitted(context);
  const first = context.session.command({ type: "snapshot" });
  const second = context.session.command({ type: "participantCount", broadcast: false });
  const [one, two] = context.socket().sent.slice(1);
  assert.deepEqual([one.id, two.id], [1, 2]);
  assert.deepEqual(one.stamp, stamp);
  context.socket().server({ type: "result", version: 1, id: 2, stamp, ok: false, error: { code: "denied" } });
  context.socket().server({ type: "result", version: 1, id: 1, stamp, ok: true, value: { peers: [] } });
  assert.deepEqual(await first, { peers: [] });
  await assert.rejects(second, (error) => error.code === "denied");
});

test("events must be contiguous; a gap triggers a snapshot", async () => {
  const context = setup();
  await admitted(context);
  const events = () => context.messages.filter((message) => message.type === "event").map((message) => message.kind);
  context.socket().server({ type: "event", version: 1, stamp, revision: 1, kind: "participantCount", value: { count: 2 } });
  context.socket().server({ type: "event", version: 1, stamp, revision: 3, kind: "participantCount", value: { count: 3 } });
  assert.deepEqual(events(), ["participantCount"]);
  const request = context.socket().sent.at(-1);
  assert.deepEqual(request.action, { type: "snapshot" });
  context.socket().server({ type: "result", version: 1, id: request.id, stamp, ok: true, value: { revision: 5, peers: [] } });
  await flush();
  assert.ok(context.messages.some((message) => message.type === "snapshot"));
  context.socket().server({ type: "event", version: 1, stamp, revision: 6, kind: "participantCount", value: { count: 1 } });
  assert.deepEqual(events(), ["participantCount", "participantCount"]);
});

test("frames for another session stamp are ignored", async () => {
  const context = setup();
  await admitted(context);
  context.socket().server({ type: "event", version: 1, stamp: { ...stamp, sessionId: "other" }, revision: 1, kind: "x", value: {} });
  assert.equal(context.messages.filter((message) => message.type === "event").length, 0);
});

test("unexpected close rejects pending commands and resumes the same session", async () => {
  const context = setup();
  await admitted(context);
  const pending = context.session.command({ type: "snapshot" });
  context.socket().close();
  await assert.rejects(pending, (error) => error.code === "disconnected");
  assert.ok(context.messages.some((message) => message.status === "reconnecting"));
  context.timers.fire(RECONNECT_DELAYS_MS[0]);
  await flush();
  assert.deepEqual(context.socket().sent[0], { type: "resume", version: 1, sessionId: "s1", recoveryToken: "rt1", ownerProof: "a".repeat(64) });
  context.socket().server({ type: "welcome", version: 1, stamp, recoveryToken: "rt2", revision: 0, phase: "admitted", presenter: false });
  await flush();
  assert.equal(context.messages.at(-1).status, "admitted");
});

test("recovery gives up after the bounded attempts", async () => {
  const context = setup();
  await admitted(context);
  context.socket().close();
  for (const delay of RECONNECT_DELAYS_MS) {
    context.timers.fire(delay);
    await flush();
    context.socket().close();
    await flush();
  }
  assert.equal(context.messages.at(-1).status, "failed");
  assert.equal(FakeSocket.instances.length, 1 + RECONNECT_DELAYS_MS.length);
});

test("explicit leave sends leave, closes and does not recover", async () => {
  const context = setup();
  await admitted(context);
  const leaving = context.session.leave();
  const request = context.socket().sent.at(-1);
  assert.deepEqual(request.action, { type: "leave" });
  context.socket().server({ type: "result", version: 1, id: request.id, stamp, ok: true, value: {} });
  await leaving;
  assert.equal(context.messages.at(-1).status, "left");
  assert.ok(!context.messages.some((message) => message.status === "reconnecting"));
  await assert.rejects(context.session.command({ type: "snapshot" }), (error) => error.code === "disconnected");
});

test("unload leave closes without sending leave, so the server keeps the session for takeover", async () => {
  const context = setup();
  await admitted(context);
  const sent = context.socket().sent.length;
  await context.session.leave({ notify: false });
  assert.equal(context.socket().sent.length, sent, "no leave command");
  assert.equal(context.messages.at(-1).status, "left");
  assert.ok(!context.messages.some((message) => message.status === "reconnecting"));
});

test("a session-ending event is delivered even after a revision gap", async () => {
  for (const [name, kind, value] of [
    ["takeover", "sessionReplaced", {}],
    ["kick", "peerAction", { action: "eject" }],
  ]) {
    const context = setup();
    await admitted(context);
    const before = context.socket().sent.length;
    context.socket().server({ type: "event", version: 1, stamp, revision: 9, kind, value });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(context.messages.some((message) => message.type === "event" && message.kind === kind), name);
    assert.equal(context.socket().sent.length, before, `${name}: no snapshot repair`);
  }
});

test("resume applies jitter to its timer and leave suppresses the delayed attempt", async () => {
  const context = setup(() => 0);
  await admitted(context);
  context.socket().close();
  await flush();
  context.timers.fire(RECONNECT_DELAYS_MS[0]);
  await flush();
  assert.equal(FakeSocket.instances.length, 1, "upper-bound delay was not scheduled");
  await context.session.leave({ notify: false });
  context.timers.fire(RECONNECT_DELAYS_MS[0] / 2);
  await flush();
  assert.equal(FakeSocket.instances.length, 1, "leave prevents the jittered resume");
});
