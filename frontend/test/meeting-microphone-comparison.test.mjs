import assert from "node:assert/strict";
import { test } from "node:test";
import { createMicrophoneComparison } from "../features/meeting/client/microphoneComparison.mjs";

/** Deferred promises model permission prompts that outlive a menu or device. */
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
/** Independent capture and graph resources, with no access to the call's live track. */
function setup({ failContext = false } = {}) {
  let devices = [{ value: "one" }, { value: "two" }];
  const observers = new Set();
  const requests = [];
  const contexts = [];
  const timers = new Set();
  const streams = [];
  const capture = { getSnapshot: () => ({ inputDevices: devices }), subscribe: (fn) => (observers.add(fn), () => observers.delete(fn)) };
  /** Fake graph samples a different waveform per independent probe. */
  class Context {
    constructor() { if (failContext) throw new Error("Unavailable"); contexts.push(this); }
    createAnalyser() { return { getByteTimeDomainData(data) { data.fill(this.sample || 128); }, disconnect() {} }; }
    createMediaStreamSource(stream) { return { connect(analyser) { analyser.sample = stream.sample; }, disconnect() {} }; }
    async resume() {}
    async close() { this.closed = true; }
  }
  const source = createMicrophoneComparison({ capture, AudioContextImpl: Context,
    mediaDevices: { getUserMedia(constraints) { const request = deferred(); requests.push({ ...request, constraints }); return request.promise; } },
    schedule: (fn) => (timers.add(fn), fn), cancel: (fn) => timers.delete(fn) });
  return { source, requests, contexts, observers, timers, streams,
    resolve(index, sample = 160) {
      const track = { stopped: 0, stop() { this.stopped++; } };
      const stream = { sample, getTracks: () => [track], track };
      streams.push(stream); requests[index].resolve(stream); return stream;
    },
    update(values) { devices = values.map((value) => ({ value })); observers.forEach((fn) => fn()); },
    tick() { timers.forEach((fn) => fn()); },
  };
}
/** Let resolved capture promises connect their graphs. */
async function settle() { await Promise.resolve(); await Promise.resolve(); }

for (const scenario of ["independent levels", "late permission after close", "reopen before permission", "device removal", "permission denied", "context unavailable"]) {
  test(`microphone comparison lifecycle: ${scenario}`, async () => {
    const h = setup({ failContext: scenario === "context unavailable" });
    assert.equal(h.requests.length, 0);
    const off = h.source.subscribe(() => {});
    if (scenario === "context unavailable") {
      assert.equal(h.source.getSnapshot().one.status, "unavailable"); off(); return;
    }
    assert.equal(h.contexts.length, 1);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[0].constraints.audio, { deviceId: { exact: "one" }, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    if (scenario === "late permission after close") off();
    const offNew = scenario === "reopen before permission" ? (off(), h.source.subscribe(() => {})) : null;
    if (scenario === "device removal") h.update(["two"]);
    if (scenario === "permission denied") h.requests[0].reject(new DOMException("Denied", "NotAllowedError"));
    else h.resolve(0);
    h.resolve(1, 144);
    await settle();
    h.tick();
    if (scenario === "independent levels") {
      assert.equal(h.source.getSnapshot().one.level, 0.375);
      assert.equal(h.source.getSnapshot().two.level, 0.1875);
      h.update(["one", "two"]);
      assert.equal(h.requests.length, 2);
    }
    if (scenario === "permission denied") assert.equal(h.source.getSnapshot().one.status, "unavailable");
    if (scenario === "device removal") assert.equal(h.source.getSnapshot().one, undefined);
    if (scenario === "reopen before permission") { h.resolve(2); h.resolve(3); await settle(); offNew(); }
    else off();
    assert.equal(h.timers.size, 0);
    assert.equal(h.observers.size, 0);
    assert.equal(h.contexts.every((context) => context.closed), true);
    assert.equal(h.streams.every((stream) => stream.track.stopped === 1), true);
    assert.deepEqual(h.source.getSnapshot(), {});
  });
}
