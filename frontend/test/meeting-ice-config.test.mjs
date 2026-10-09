import assert from "node:assert/strict";
import test from "node:test";
import { createIceConfiguration, iceOptions } from "../features/meeting/client/iceConfig.mjs";

/** Synthetic temporary credentials with deterministic expiry, never real relay access. */
function relay(expiresAt = 4600) {
  return { iceServers: [{ urls: ["turns:turn.example.test:443?transport=tcp"], username: "4600:session", credential: "temporary" }],
    iceTransportPolicy: "relay", expiresAt };
}

/** Manual time and timer ownership for credential expiry and late-response checks. */
function fixture(command = async () => relay()) {
  let time = 1000000;
  let requests = 0;
  let failures = 0;
  const timers = new Map();
  const applied = [];
  let id = 0;
  const ice = createIceConfiguration({
    command: async (action) => { assert.deepEqual(action, { type: "iceConfig" }); requests++; return command(); },
    apply: async (options) => applied.push(options), onFailure: () => failures++, now: () => time, random: () => 0.5,
    setTimer: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    clearTimer: (timer) => timers.delete(timer),
  });
  return { ice, timers, applied, stats: () => ({ requests, failures }), advance: (ms) => { time += ms; },
    async fire() { const [key, timer] = timers.entries().next().value; timers.delete(key); timer.callback(); await new Promise((resolve) => setImmediate(resolve)); },
  };
}

for (const [name, value] of [
  ["missing configuration", undefined],
  ["empty forced relay", { iceServers: [], iceTransportPolicy: "relay", expiresAt: null }],
  ["expired credentials", relay(1000)],
  ["unknown policy", { ...relay(), iceTransportPolicy: "direct" }],
  ["missing credential", { ...relay(), iceServers: [{ urls: ["turn:example.test"], username: "session" }] }],
  ["untrusted URL", { ...relay(), iceServers: [{ urls: ["https://example.test"], username: "session", credential: "temp" }] }],
]) test(`ICE configuration rejects ${name}`, () => assert.throws(() => iceOptions(value, 1000000)));

test("credential requests coalesce and schedule one jittered refresh before expiry", async () => {
  const context = fixture();
  const [first, second] = await Promise.all([context.ice.refresh(), context.ice.refresh()]);
  assert.deepEqual(first, second);
  assert.equal(context.stats().requests, 1);
  assert.equal(context.timers.size, 1);
  assert.equal([...context.timers.values()][0].delay, 3060000);
  await context.ice.refresh();
  assert.equal(context.timers.size, 1, "manual recovery replaces the prior timer");
  context.ice.close();
  assert.equal(context.timers.size, 0);
});

test("disabled TURN never starts a credential refresh timer", async () => {
  const context = fixture(async () => ({ iceServers: [], iceTransportPolicy: "all", expiresAt: null }));
  assert.deepEqual(await context.ice.refresh(), { iceServers: [], iceTransportPolicy: "all" });
  assert.equal(context.timers.size, 0);
});

test("refresh failures retry only while old credentials remain valid", async () => {
  let fail = false;
  const context = fixture(async () => { if (fail) throw new Error("disconnected"); return relay(); });
  await context.ice.refresh();
  fail = true;
  await context.fire();
  assert.equal(context.stats().failures, 0);
  assert.equal([...context.timers.values()][0].delay, 7500);
  context.advance(3600001);
  await context.fire();
  assert.equal(context.stats().failures, 1);
  assert.equal(context.timers.size, 0);
  assert.equal(context.applied.length, 1, "failure cannot replace forced relay with direct ICE");
});

test("closing during issuance fences the late response and its timer", async () => {
  let resolve;
  const context = fixture(() => new Promise((done) => { resolve = done; }));
  const response = context.ice.refresh();
  context.ice.close();
  resolve(relay());
  await assert.rejects(response, /closed/);
  assert.equal(context.applied.length, 0);
  assert.equal(context.timers.size, 0);
});

test("expired refreshed credentials are rejected without weakening relay policy", async () => {
  const context = fixture(async () => relay(900));
  await assert.rejects(context.ice.refresh(), /Expired/);
  assert.equal(context.applied.length, 0);
  assert.equal(context.timers.size, 0);
});
