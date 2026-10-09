import assert from "node:assert/strict";
import { test } from "node:test";
import { createInputLevelMeter } from "../features/meeting/client/inputLevelMeter.mjs";

for (const scenario of ["device replacement", "processing replacement", "track removed", "shared subscribers", "same track update", "late capture"]) {
  test(`input meter lifecycle: ${scenario}`, () => {
    let track = scenario === "late capture" ? null : { id: "first" };
    const contexts = [];
    const timers = new Map();
    const observers = new Set();
    const capture = { track: () => track, subscribe: (fn) => (observers.add(fn), () => observers.delete(fn)) };
    /** Fake analyser observes a known nonzero waveform without audio hardware. */
    class Context {
      constructor() { contexts.push(this); this.closed = false; }
      createAnalyser() { return { getByteTimeDomainData: (data) => data.fill(160), disconnect() {} }; }
      createMediaStreamSource(stream) { this.track = stream.track; return { connect() {}, disconnect() {} }; }
      async close() { this.closed = true; }
    }
    /** Keep the captured track visible to the fake graph. */
    class Stream { constructor(tracks) { this.track = tracks[0]; } }
    const meter = createInputLevelMeter({ capture, AudioContextImpl: Context, MediaStreamImpl: Stream,
      schedule: (fn) => (timers.set(fn, fn), fn), cancel: (fn) => timers.delete(fn) });
    const off = meter.subscribe(() => {});
    const offSecond = scenario === "shared subscribers" ? meter.subscribe(() => {}) : null;
    if (scenario === "device replacement" || scenario === "processing replacement" || scenario === "late capture") track = { id: "replacement" };
    if (scenario === "track removed") track = null;
    observers.forEach((fn) => fn());
    for (const tick of timers.values()) tick();
    assert.equal(meter.getSnapshot(), track ? 0.375 : 0);
    assert.equal(contexts.length, scenario.includes("replacement") ? 2 : 1);
    if (track) assert.equal(contexts.at(-1).track, track);
    if (scenario.includes("replacement") || scenario === "track removed") assert.equal(contexts[0].closed, true);
    off();
    if (offSecond) { assert.equal(timers.size, 1); offSecond(); }
    assert.equal(timers.size, 0);
    assert.equal(observers.size, 0);
    assert.equal(meter.getSnapshot(), 0);
    assert.equal(contexts.every((context) => context.closed), true);
    meter.dispose();
  });
}
