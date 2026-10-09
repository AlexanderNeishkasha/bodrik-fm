import assert from "node:assert/strict";
import { build } from "esbuild";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const compiled = await build({ entryPoints: [fileURLToPath(new URL("../app/lib/audioPulseRuntime.js", import.meta.url))], bundle: true, format: "cjs", platform: "node", write: false });
const evaluated = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, { module: evaluated, exports: evaluated.exports, Uint8Array });
const runtime = evaluated.exports.default;
const math = await build({ entryPoints: [fileURLToPath(new URL("../app/lib/audioPulseMath.js", import.meta.url))], bundle: true, format: "cjs", platform: "node", write: false });
const mathModule = { exports: {} };
vm.runInNewContext(math.outputFiles[0].text, { module: mathModule, exports: mathModule.exports });
const { smoothPulse } = mathModule.exports;

/** Minimal event source with observable listener ownership. */
function events(extra = {}) {
  const listeners = new Map();
  return Object.assign(extra, {
    listeners,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name) { for (const fn of [...(listeners.get(name) || [])]) fn(); },
  });
}

/** Deterministic clock and graph prove visual scheduling cannot interrupt audio. */
function fixture(options = {}) {
  let now = 0;
  let reads = 0;
  let suspends = 0;
  let sources = 0;
  let resumes = 0;
  const timers = new Map();
  const writes = [];
  const panel = { style: { setProperty: (...args) => writes.push(args) } };
  const audio = events({ isConnected: true, pause() { this.paused = true; this.emit("pause"); }, paused: true, ended: false, muted: false, volume: 1, closest: () => panel });
  const doc = events({ hidden: false });
  const scope = events({ document: doc, performance: { now: () => now },
    setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    AudioContext: class {
      state = "running";
      destination = {};
      createAnalyser() { return { connect() {}, getByteFrequencyData(data) { reads++; data.fill(128); } }; }
      createMediaElementSource() { sources++; return { connect() {}, disconnect() { assert.fail("must not disconnect audio"); } }; }
      resume() { resumes++; this.state = "running"; return Promise.resolve(); }
      suspend() { suspends++; this.state = "suspended"; return Promise.resolve(); }
    },
  });
  const controller = runtime({ scope, unlocked: true, ...options });
  controller.bind(audio);
  return { audio, doc, scope, controller, timers, writes, get reads() { return reads; }, get suspends() { return suspends; }, get sources() { return sources; }, get resumes() { return resumes; },
    step() { now += 1000 / 30; const callbacks = [...timers.values()]; timers.clear(); for (const fn of callbacks) fn(); },
    settle() { for (let i = 0; i < 100; i++) this.step(); },
  };
}

for (const name of ["pause", "ended", "muted", "zero volume", "hidden", "disabled"]) {
  test(`audio pulse lifecycle: ${name}`, () => {
    const f = fixture({ enabled: name !== "disabled" });
    assert.equal(f.timers.size, 0, "paused mount is idle");
    f.audio.paused = false; f.audio.emit("play");
    f.step();
    if (name === "disabled") { assert.equal(f.timers.size, 0); assert.equal(f.sources, 0); return f.controller.dispose(); }
    assert.equal(f.timers.size, 1);
    if (name === "pause") { f.audio.paused = true; f.audio.emit("pause"); }
    if (name === "ended") { f.audio.ended = true; f.audio.emit("ended"); }
    if (name === "muted") { f.audio.muted = true; f.audio.emit("volumechange"); }
    if (name === "zero volume") { f.audio.volume = 0; f.audio.emit("volumechange"); }
    if (name === "hidden") { f.doc.hidden = true; f.doc.emit("visibilitychange"); }
    f.settle();
    assert.equal(f.timers.size, 0);
    assert.equal(f.writes.at(-1)[1], "0.000");
    assert.equal(f.suspends, name === "pause" || name === "ended" ? 1 : 0, "only stopped playback sleeps the graph");
    f.audio.paused = false; f.audio.ended = false; f.audio.muted = false; f.audio.volume = 1;
    f.doc.hidden = false; f.doc.emit("visibilitychange");
    assert.equal(f.timers.size, 1, "resume restarts samples");
    f.controller.dispose(); f.controller.dispose();
    assert.equal(f.timers.size, 0);
    assert.equal([...f.audio.listeners.values()].reduce((sum, set) => sum + set.size, 0), 4, "only the retained graph owns media listeners");
    assert.equal([...f.scope.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0);
    assert.equal([...f.doc.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0);
  });
}

test("audio pulse rebinding removes old listeners and reuses the element graph", () => {
  const f = fixture();
  f.audio.paused = false; f.audio.emit("play");
  f.controller.bind(null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.suspends, 0);
  f.controller.bind(f.audio);
  assert.equal(f.sources, 1);
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
});

test("audio pulse skips unchanged writes and samples once per scheduled interval", () => {
  const f = fixture();
  const initial = f.writes.length;
  f.audio.emit("pause");
  assert.equal(f.writes.length, initial);
  f.audio.paused = false; f.audio.emit("play");
  const reads = f.reads;
  for (let i = 0; i < 30; i++) f.step();
  assert.equal(f.reads - reads, 30);
  f.controller.dispose();
});

for (const [name, initial, target, idle] of [["attack", 0, 0.8, false], ["decay", 0.8, 0.1, false], ["idle", 0.8, 0, true]]) {
  test(`pulse timing at 30 and 60 Hz: ${name}`, () => {
    let fast = initial, slow = initial;
    for (let i = 0; i < 60; i++) fast = smoothPulse(fast, target, 1000 / 60, idle);
    for (let i = 0; i < 30; i++) slow = smoothPulse(slow, target, 1000 / 30, idle);
    assert.ok(Math.abs(fast - slow) < 1e-12);
  });
}

test("disabled visualizer retains a resumable audio graph after pause and replay", () => {
  const f = fixture();
  f.audio.paused = false; f.audio.emit("play");
  f.controller.dispose();
  f.audio.paused = true; f.audio.emit("pause");
  assert.equal(f.suspends, 1, "stopped media sleeps even after visualizer cleanup");
  const disabled = runtime({ scope: f.scope, enabled: false });
  disabled.bind(f.audio);
  f.audio.paused = false; f.audio.emit("play");
  assert.equal(f.sources, 1, "no second MediaElementSource is created");
  assert.equal(f.resumes, 1, "replay resumes the retained audio path");
  assert.equal(f.timers.size, 0);
  disabled.dispose();
});

test("an unavailable AudioContext leaves playback and visual scheduling alone", () => {
  const f = fixture();
  f.scope.AudioContext = undefined;
  f.audio.paused = false; f.audio.emit("play");
  assert.equal(f.timers.size, 0);
  assert.equal(f.audio.paused, false);
  f.controller.dispose();
});

test("gesture gating starts samples only after unlock and never starts paused audio", () => {
  const f = fixture({ unlocked: false });
  f.scope.emit("pointerdown");
  assert.equal(f.sources, 0);
  f.controller.dispose();
  const controller = runtime({ scope: f.scope, unlocked: false });
  controller.bind(f.audio);
  f.audio.paused = false; f.audio.emit("play");
  assert.equal(f.sources, 0);
  f.scope.emit("bodrik_fm_audio_pulse_unlock");
  assert.equal(f.sources, 1);
  assert.equal(f.timers.size, 1);
  controller.dispose();
});

for (const name of ["dispose", "rebind"]) {
  test(`removed media cannot continue ghost playback: ${name}`, () => {
    const f = fixture();
    f.audio.paused = false; f.audio.emit("play");
    f.audio.isConnected = false;
    if (name === "dispose") f.controller.dispose();
    else f.controller.bind(null);
    assert.equal(f.audio.paused, true);
    assert.equal(f.timers.size, 0);
    assert.ok(f.suspends > 0);
    f.controller.dispose();
  });
}
