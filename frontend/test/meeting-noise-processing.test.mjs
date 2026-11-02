import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { captureConstraints, createCapture, DEFAULT_PREFERENCES, parsePreferences } from "../features/meeting/client/capture.mjs";
import { NEURAL_NOISE_MODES, NOISE_MODES, noiseModeOptions } from "../features/meeting/client/noiseModes.mjs";
import { ru } from "../app/lang/ru.js";
import { meetingUiEn } from "../app/lang/eng.js";

/** Compile the actual owner with replaceable model factories, not a second graph implementation. */
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../features/meeting/client/noiseProcessing.mjs", import.meta.url))],
  bundle: true, format: "cjs", platform: "node", write: false,
  plugins: [{ name: "model-factories", setup(builder) {
    builder.onResolve({ filter: /^@/ }, (args) => ({ path: args.path, namespace: "model" }));
    builder.onLoad({ filter: /.*/, namespace: "model" }, () => ({ contents: `
      export const createDeepFilterNetAudioWorklet = (...args) => globalThis.createDeep(...args);
      export const loadRnnoise = (...args) => globalThis.loadRnnoise(...args);
      export class RnnoiseWorkletNode extends globalThis.AudioWorkletNode { destroy() { this.destroyed = true; } }
    ` }));
  } }],
});

/** Minimal event source that lets tests observe listener ownership as well as callbacks. */
class Events {
  /** Start with no listeners. */
  constructor() { this.listeners = new Map(); }
  /** Add one listener for a worklet message or processor error. */
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  /** Remove the exact listener installed by the owner. */
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  /** Deliver an event synchronously to the current listener set. */
  emit(type, data) { for (const listener of [...this.listeners.get(type) || []]) listener({ data }); }
}

/** Isolated browser graph and model spies for one condition branch. */
function fixture(options = {}) {
  const state = { contexts: [], nodes: [], modules: [], downloads: [], errors: [], disposed: 0 };
  const output = { readyState: "live", stop() { this.readyState = "ended"; } };
  const raw = { readyState: options.ended ? "ended" : "live" };
  /** A graph node that records connections without executing audio. */
  class Node extends Events {
    /** Save initialization options and own a separately observable message port. */
    constructor(context, name, settings) {
      super(); this.name = name; this.settings = settings; this.port = new Events();
      this.port.start = () => {};
      this.port.postMessage = (value) => { this.sent = value; };
      state.nodes.push(this);
    }
    /** Return the target as native AudioNode.connect does. */
    connect(target) { if (options.connectError) throw new Error("connect failed"); this.target = target; return target; }
    /** Record release of a graph edge. */
    disconnect() { this.disconnected = true; }
  }
  /** One fake AudioContext, with real ownership semantics recorded by spies. */
  class Context {
    /** Retain requested sample rate and expose a controllable worklet loader. */
    constructor(settings) {
      this.sampleRate = settings.sampleRate; state.contexts.push(this);
      this.audioWorklet = { addModule: async (url) => { state.modules.push(url); if (options.moduleError) throw new Error("module failed"); } };
    }
    /** Simulate autoplay rejection if requested. */
    async resume() { if (options.resumeError) throw new Error("resume failed"); }
    /** Close WASM's owning context exactly once. */
    async close() { this.closed = (this.closed || 0) + 1; }
    /** Save the caller-owned input without stopping it. */
    createMediaStreamSource(stream) { this.input = stream; return (this.source = new Node()); }
    /** Produce an owned track, or exercise the missing-output failure. */
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => options.noOutput ? [] : [output] } }; }
  }
  const evaluated = { exports: {} };
  const scope = {
    module: evaluated, exports: evaluated.exports, AudioContext: Context, AudioWorkletNode: Node,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } }, DOMException, queueMicrotask,
    console,
    async loadRnnoise(settings) { state.rnnoise = settings; return new ArrayBuffer(8); },
    async createDeep(context, settings) {
      state.deep = settings;
      if (options.deferred) await new Promise(resolve => { state.finishDownload = resolve; });
      const node = new Node(context, "deepfilternet");
      return { node, ready: options.initError ? Promise.reject(new Error("bad model")) : Promise.resolve(), dispose() { state.disposed++; node.disconnect(); } };
    },
  };
  vm.runInNewContext(compiled.outputFiles[0].text, scope);
  return { state, output, raw, processNoise: evaluated.exports.processNoise };
}

for (const mode of NOISE_MODES) {
  test(`noise mode validation, persistence and browser constraint: ${mode}`, () => {
    const stored = { ...DEFAULT_PREFERENCES, noiseMode: mode };
    assert.deepEqual(parsePreferences(JSON.stringify(stored)), stored);
    assert.equal(captureConstraints("audio", stored).audio.noiseSuppression, mode === "browser");
    assert.equal(captureConstraints("audio", stored).audio.autoGainControl, !NEURAL_NOISE_MODES.includes(mode));
    assert.equal(captureConstraints("audio", { ...stored, autoGainControl: false }).audio.autoGainControl, false);
    let saved;
    const capture = createCapture({ storage: {
      getItem() { return JSON.stringify({ noiseMode: mode === "browser" ? "off" : "browser" }); },
      setItem(key, value) { saved = value; },
    } });
    capture.setPreference("noiseMode", mode);
    assert.equal(JSON.parse(saved).noiseMode, mode);
  });
}

test("both menus share all neural choices without renaming saved values", () => {
  const text = { off: "Off", browser: "Basic", enhanced: "Enhanced", maximum: "Maximum" };
  assert.deepEqual(noiseModeOptions(text, true).map(({ value }) => value), NOISE_MODES);
  assert.deepEqual(noiseModeOptions(text, false).map(({ value }) => value), ["off", "browser"]);
});

for (const mode of NEURAL_NOISE_MODES) {
  test(`graph initialization, runtime errors and idempotent cleanup: ${mode}`, async () => {
    const f = fixture();
    const handle = await f.processNoise(f.raw, { mode, onError: (error) => f.state.errors.push(error.message) });
    assert.equal(handle.track, f.output);
    assert.equal(f.state.contexts[0].sampleRate, 48000);
    assert.equal(f.state.contexts[0].input.tracks[0], f.raw);
    const node = f.state.nodes[0];
    node.port.emit("message", { type: "ready" });
    assert.equal(f.state.errors.length, 0);
    node.port.emit("message", { type: "error", message: "runtime failure" });
    node.emit("processorerror");
    assert.equal(f.state.errors.length, 2);
    handle.dispose(); handle.dispose();
    node.port.emit("message", { type: "error", message: "late" });
    assert.equal(f.state.errors.length, 2);
    assert.equal(f.output.readyState, "ended");
    assert.equal(f.raw.readyState, "live");
    assert.equal(f.state.contexts[0].closed, 1);
    assert.equal(node.listeners.get("processorerror")?.size, 0);
    assert.equal(node.port.listeners.get("message")?.size, 0);
    assert.equal(f.state.disposed, mode === "deepfilternet" ? 1 : 0);
    if (mode === "deepfilternet") {
      assert.equal(f.state.deep.modelUrl, "/meeting-assets/deepfilternet/DeepFilterNet3_onnx.tar.gz");
      assert.equal(f.state.deep.bypassUntilReady, false);
    } else assert.ok(f.state.modules[0].startsWith(`/meeting-assets/${mode}/`));
    const gain = f.state.nodes.find(node => node.name === "meeting-denoised-gain");
    assert.ok(gain);
    assert.equal(gain.settings.outputChannelCount[0], 1);
    assert.equal(gain.disconnected, true);
    if (mode === "rnnoise") assert.equal(node.channelCount, 1);
  });
}

test("disabling automatic gain bypasses the post-denoiser leveller", async () => {
  const f = fixture();
  const handle = await f.processNoise(f.raw, { mode: "rnnoise", autoGainControl: false });
  assert.equal(f.state.nodes.some(node => node.name === "meeting-denoised-gain"), false);
  assert.equal(f.state.modules.includes("/meeting-assets/denoisedGain/workletProcessor.js"), false);
  handle.dispose();
});

for (const [name, mode, options] of [
  ["autoplay rejection", "rnnoise", { resumeError: true }],
  ["module load rejection", "rnnoise", { moduleError: true }],
  ["DeepFilterNet initialization rejection", "deepfilternet", { initError: true }],
  ["capture ended during load", "deepfilternet", { ended: true }],
  ["connection rejection", "rnnoise", { connectError: true }],
  ["missing output", "rnnoise", { noOutput: true }],
]) {
  test(`initialization failure releases the graph: ${name}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.processNoise(f.raw, { mode }));
    assert.equal(f.state.contexts[0].closed, 1);
    if (f.state.nodes[0]) assert.equal(f.state.nodes[0].disconnected, true);
    if (!options.ended) assert.equal(f.raw.readyState, "live");
  });
}

for (const mode of ["deepfilternet"]) {
  test(`cancellation closes the context while initialization is pending: ${mode}`, async () => {
    const f = fixture({ deferred: true });
    const controller = new AbortController();
    const pending = f.processNoise(f.raw, { mode, signal: controller.signal });
    // Let the real async owner reach its model factory without relying on a fixed wait.
    while (!f.state.finishDownload) await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    f.state.finishDownload?.();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(f.state.contexts[0].closed, 1);
    assert.equal(f.raw.readyState, "live");
    assert.equal(f.state.nodes[0].disconnected, true);
  });
}

for (const [language, dictionary, labels] of [
  ["Russian", ru, ["Выключено", "Браузерное", "Умное", "Студийное"]],
  ["English", { meeting: meetingUiEn }, ["Off", "Browser", "Smart", "Studio"]],
]) {
  for (const menu of ["micQuickMenu", "audioSettings"]) {
    test(`noise choices are localized in ${menu}: ${language}`, () => {
      assert.deepEqual(noiseModeOptions(dictionary.meeting[menu], true).map(option => option.label), labels);
    });
  }
}

test("removed engine cannot be started or selected but saved preferences retain other settings", async () => {
  const f = fixture();
  await assert.rejects(f.processNoise(f.raw, { mode: "gtcrn" }), /Unknown neural/);
  assert.equal(f.state.contexts.length, 0);
  assert.equal(NOISE_MODES.includes("gtcrn"), false);
  const capture = createCapture({});
  assert.throws(() => capture.setPreference("noiseMode", "gtcrn"), /Invalid/);
  assert.deepEqual(parsePreferences(JSON.stringify({ noiseMode: "gtcrn", echoCancellation: false })),
    { ...DEFAULT_PREFERENCES, echoCancellation: false });
});

test("already cancelled startup allocates no context", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.processNoise(f.raw, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.state.contexts.length, 0);
});

test("unknown neural mode is rejected before allocating audio resources", async () => {
  const f = fixture();
  await assert.rejects(f.processNoise(f.raw, { mode: "unknown" }), /Unknown neural/);
  assert.equal(f.state.contexts.length, 0);
});
