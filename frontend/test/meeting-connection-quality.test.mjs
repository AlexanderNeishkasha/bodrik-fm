import assert from "node:assert/strict";
import test from "node:test";
import { createQualityMonitor, createQualityTracker, QUALITY_INTERVAL_MS } from "../features/meeting/client/connectionQuality.mjs";
import { qualityReport } from "./helpers/meetingQuality.mjs";

/** Feed independently updated two-second intervals through warmup and the decision window. */
function sequence(options, { end = 14000, mutate = () => {} } = {}) {
  const tracker = createQualityTracker();
  const decisions = [];
  for (let time = 0; time <= end; time += 2000) {
    const step = time / 2000;
    const report = qualityReport({ time, received: step * 90, lost: step * 10, samples: step * 96000, ...options });
    mutate(report, time);
    const result = tracker.sample(report, time);
    if (result) decisions.push({ time, ...result });
  }
  return decisions;
}

for (const [name, options, change, expected] of [
  ["sustained incoming audio loss", {}, {}, "packet-loss"],
  ["outgoing RTCP loss", { sending: true }, {}, "packet-loss"],
  ["high video loss", { kind: "video" }, { mutate: (report, time) => { report.get("stream").packetsLost = time / 2000 * 30; } }, "video-packet-loss"],
  ["moderate video loss with high RTT", { kind: "video", rtt: 0.4 }, {}, "video-packet-loss"],
  ["healthy audio", { lost: 0 }, {}, null],
  ["video loss without a second network signal", { kind: "video" }, {}, null],
  ["CPU limited outgoing video", { kind: "video", sending: true, fractionLost: 0.3, cpu: true }, {}, null],
  ["already relayed media", { candidateType: "relay" }, {}, null],
  ["no active media", { received: 0, lost: 0 }, {}, null],
  ["insufficient packets", { received: 2, lost: 1 }, {}, null],
  ["unknown candidate type", { candidateType: undefined }, { mutate: (report) => { delete report.get("candidate").candidateType; } }, null],
]) test(`quality classification: ${name}`, () => {
  const decisions = sequence(options, change);
  assert.equal(decisions[0]?.reason ?? null, expected);
  if (expected) assert.equal(decisions[0].time, 14000, "warmup plus three fresh bad intervals");
});

for (const [name, lostPerWindow, rtt, concealment, expected] of [
  ["eight percent boundary", 8, 0.1, 0, "packet-loss"],
  ["below eight percent", 7, 0.1, 0, null],
  ["three percent and 600ms RTT", 3, 0.6, 0, "loss-and-latency"],
  ["high RTT alone", 0, 1, 0, null],
  ["three percent and ten percent concealed audio", 3, 0.1, 0.1, "audio-concealment"],
  ["concealment without loss", 0, 0.1, 0.5, null],
]) test(`quality thresholds: ${name}`, () => {
  const decisions = sequence({ rtt }, { mutate: (report, time) => {
    const stream = report.get("stream");
    stream.packetsReceived = time / 2000 * (100 - lostPerWindow);
    stream.packetsLost = time / 2000 * lostPerWindow;
    stream.concealedSamples = time / 2000 * 96000 * concealment;
  } });
  assert.equal(decisions[0]?.reason ?? null, expected);
});

for (const [name, change] of [
  ["one good interval", (report, time) => { if (time === 12000) report.get("stream").packetsLost -= 10; }],
  ["counter reset", (report, time) => { if (time === 12000) report.get("stream").packetsReceived = 0; }],
  ["route replacement", (report, time) => { if (time >= 12000) report.get("transport").selectedCandidatePairId = "missing"; }],
  ["stream removal", (report, time) => { if (time === 12000) report.delete("stream"); }],
  ["cached remote report", (report) => { report.get("stream").timestamp = 1; }],
]) test(`quality evidence resets after ${name}`, () => assert.deepEqual(sequence({}, { mutate: change }), []));

test("suspension resets the warmup and never converts a large cumulative delta into bad windows", () => {
  const tracker = createQualityTracker();
  for (const time of [0, 2000, 4000, 6000, 8000, 10000, 12000, 30000, 32000, 34000]) {
    assert.equal(tracker.sample(qualityReport({ time, received: time, lost: time / 10 }), time), null);
  }
});

test("an invalid inbound loss counter and RTX stream cannot produce a decision", () => {
  for (const mutation of [
    (report) => { delete report.get("stream").packetsLost; },
    (report) => { report.get("stream").codecId = "rtx"; report.set("rtx", { id: "rtx", mimeType: "video/rtx" }); },
  ]) assert.deepEqual(sequence({}, { mutate: mutation }), []);
});

test("cached outgoing RTCP reports and missing sender loss fields never count as new bad windows", () => {
  for (const mutation of [
    (report) => { report.get("stream").timestamp = 1; },
    (report) => { delete report.get("stream").fractionLost; },
  ]) assert.deepEqual(sequence({ sending: true }, { mutate: mutation }), []);
});

test("the minimum evidence boundary is 50 packets per interval", () => {
  for (const [received, expected] of [[46, "packet-loss"], [45, null]]) {
    const decisions = sequence({}, { mutate: (report, time) => {
      report.get("stream").packetsReceived = time / 2000 * received;
      report.get("stream").packetsLost = time / 2000 * 4;
    } });
    assert.equal(decisions[0]?.reason ?? null, expected);
  }
});

/** Manual monotonic clock and one-shot timers for the async poll owner. */
function monitorFixture(getStats, { secondStats } = {}) {
  let time = 0;
  let id = 0;
  const timers = new Map();
  const decisions = [];
  const errors = [];
  const transport = { connectionState: "connected", getStats: () => getStats(time) };
  const transports = [transport];
  if (secondStats) transports.push({ connectionState: "connected", getStats: () => secondStats(time) });
  const monitor = createQualityMonitor({ transports, onPoorQuality: (value) => decisions.push(value), now: () => time,
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer: (key) => timers.delete(key),
    onError: (error) => errors.push(error) });
  return { monitor, decisions, timers, errors, transport,
    async tick() {
      const [key, { fn, ms }] = timers.entries().next().value;
      timers.delete(key);
      time += ms;
      await fn();
    },
  };
}

test("monitor switches once and owns no timer after closing", async () => {
  const context = monitorFixture((time) => qualityReport({ time, received: time, lost: time / 10 }));
  assert.equal([...context.timers.values()][0].ms, QUALITY_INTERVAL_MS);
  for (let index = 0; index < 8; index++) await context.tick();
  assert.equal(context.decisions.length, 1);
  assert.equal(context.timers.size, 0);
  context.monitor.close();
});

test("a pending statistics request cannot schedule more work or switch after disposal", async () => {
  let complete;
  const context = monitorFixture(() => new Promise((resolve) => { complete = resolve; }));
  const pending = context.tick();
  assert.equal(context.timers.size, 0, "no overlapping poll while getStats is pending");
  context.monitor.close();
  complete(qualityReport());
  await pending;
  assert.deepEqual(context.decisions, []);
  assert.equal(context.timers.size, 0);
});

test("statistics errors warn once per failure streak and do not tear down the call", async () => {
  const context = monitorFixture(async () => { throw new Error("stats unavailable"); });
  await context.tick();
  await context.tick();
  assert.equal(context.errors.length, 1);
  assert.equal(context.timers.size, 1);
  assert.deepEqual(context.decisions, []);
  context.monitor.close();
  assert.equal(context.timers.size, 0);
});

test("unavailable send statistics do not hide persistent receive-side loss", async () => {
  const context = monitorFixture(async () => { throw new Error("send stats unavailable"); },
    { secondStats: (time) => qualityReport({ time, received: time, lost: time / 10 }) });
  for (let index = 0; index < 8; index++) await context.tick();
  assert.equal(context.decisions.length, 1);
  assert.equal(context.decisions[0].direction, "receive");
  assert.equal(context.errors.length, 1);
  assert.equal(context.timers.size, 0);
});

test("disconnection discards the old route's degradation streak", async () => {
  const context = monitorFixture((time) => qualityReport({ time, received: time, lost: time / 10 }));
  for (let index = 0; index < 7; index++) await context.tick();
  context.transport.connectionState = "disconnected";
  await context.tick();
  context.transport.connectionState = "connected";
  for (let index = 0; index < 3; index++) await context.tick();
  assert.deepEqual(context.decisions, []);
  context.monitor.close();
});
