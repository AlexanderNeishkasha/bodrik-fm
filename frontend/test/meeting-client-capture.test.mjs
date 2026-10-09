import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_PREFERENCES, captureConstraints, createCapture, parsePreferences } from "../features/meeting/client/capture.mjs";

/** Fake track with stop tracking. */
function track(kind) {
  return { kind, stopped: false, contentHint: "", stop() { this.stopped = true; } };
}

/** Fake mediaDevices recording requested constraints. */
function devices({ fail = false } = {}) {
  const requests = [];
  return {
    requests,
    async getUserMedia(constraints) {
      requests.push(constraints);
      if (fail) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      const tracks = constraints.audio ? [track("audio")] : [track("video")];
      return { getAudioTracks: () => tracks.filter((value) => value.kind === "audio"), getVideoTracks: () => tracks.filter((value) => value.kind === "video"), getTracks: () => tracks };
    },
    async getDisplayMedia(constraints) {
      requests.push(constraints);
      const tracks = [track("video"), track("audio")];
      return { getAudioTracks: () => [tracks[1]], getVideoTracks: () => [tracks[0]], getTracks: () => tracks };
    },
    async enumerateDevices() {
      return [
        { kind: "audioinput", deviceId: "mic-1", label: "Mic" },
        { kind: "audioinput", deviceId: "", label: "hidden" },
        { kind: "videoinput", deviceId: "cam-1", label: "" },
        { kind: "audiooutput", deviceId: "spk-1", label: "Speaker" },
      ];
    },
  };
}

/** In-memory storage. */
function memoryStorage(initial) {
  const data = new Map(initial ? [["meeting.capture.v1", initial]] : []);
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}

test("stored preferences merge over defaults and drop invalid values", () => {
  assert.equal(DEFAULT_PREFERENCES.noiseMode, "browser");
  const cases = [
    ["missing", null, DEFAULT_PREFERENCES],
    ["corrupt json", "{", DEFAULT_PREFERENCES],
    ["valid override", JSON.stringify({ quality: "fhd", echoCancellation: false }), { ...DEFAULT_PREFERENCES, quality: "fhd", echoCancellation: false }],
    ["saved basic suppression", JSON.stringify({ noiseMode: "browser" }), { ...DEFAULT_PREFERENCES, noiseMode: "browser" }],
    ["saved enhanced suppression", JSON.stringify({ noiseMode: "rnnoise" }), { ...DEFAULT_PREFERENCES, noiseMode: "rnnoise" }],
    ["saved suppression off", JSON.stringify({ noiseMode: "off" }), { ...DEFAULT_PREFERENCES, noiseMode: "off" }],
    ["invalid values ignored", JSON.stringify({ quality: "16k", noiseMode: "deep", unknown: 1 }), DEFAULT_PREFERENCES],
  ];
  for (const [name, raw, expected] of cases) assert.deepEqual(parsePreferences(raw), expected, name);
});

test("constraints follow preferences", () => {
  const prefs = { ...DEFAULT_PREFERENCES, inputDevice: "mic-1", noiseMode: "off", camera: "cam-1", quality: "vga", frameRate: "max" };
  assert.deepEqual(captureConstraints("audio", prefs), { audio: { deviceId: { exact: "mic-1" }, echoCancellation: true, autoGainControl: true, noiseSuppression: false } });
  assert.deepEqual(captureConstraints("camera", prefs), { video: { width: { ideal: 640 }, height: { ideal: 480 }, deviceId: { exact: "cam-1" } } });
  assert.deepEqual(captureConstraints("screen", DEFAULT_PREFERENCES), { audio: true, video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
  assert.equal(captureConstraints("audio", DEFAULT_PREFERENCES).audio.deviceId, undefined, "no device pin by default");
  assert.throws(() => captureConstraints("other", DEFAULT_PREFERENCES));
});

test("acquire replaces and stops the previous track of the same kind", async () => {
  const capture = createCapture({ mediaDevices: devices(), storage: memoryStorage() });
  const first = await capture.acquire("audio");
  const second = await capture.acquire("audio");
  assert.equal(first.stopped, true);
  assert.equal(second.stopped, false);
  assert.equal(capture.getSnapshot().microphone, true);
  capture.release("audio");
  assert.equal(second.stopped, true);
  assert.equal(capture.getSnapshot().microphone, false);
});

test("screen capture keeps only video and applies the content hint", async () => {
  const capture = createCapture({ mediaDevices: devices(), storage: memoryStorage() });
  const screen = await capture.acquire("screen");
  assert.equal(screen.kind, "video");
  assert.equal(screen.contentHint, "detail");
  capture.setPreference("screenHint", "motion");
  assert.equal(screen.contentHint, "motion");
});

test("failed acquisition keeps no track", async () => {
  const capture = createCapture({ mediaDevices: devices({ fail: true }), storage: memoryStorage() });
  await assert.rejects(capture.acquire("camera"), { name: "NotAllowedError" });
  assert.equal(capture.track("camera"), null);
});

test("preferences validate, persist and report the live capture they affect", async () => {
  const storage = memoryStorage();
  const capture = createCapture({ mediaDevices: devices(), storage });
  assert.throws(() => capture.setPreference("quality", "16k"));
  assert.throws(() => capture.setPreference("unknown", true));
  assert.equal(capture.setPreference("quality", "fhd"), "", "camera not live");
  await capture.acquire("camera");
  assert.equal(capture.setPreference("frameRate", "15"), "camera");
  assert.equal(capture.setPreference("frameRate", "15"), "", "unchanged");
  assert.equal(capture.setPreference("echoCancellation", false), "", "microphone not live");
  assert.equal(capture.setPreference("outputDevice", "spk-1"), "output");
  assert.equal(JSON.parse(storage.data.get("meeting.capture.v1")).frameRate, "15");
  assert.equal(createCapture({ mediaDevices: devices(), storage }).preferences.quality, "fhd", "reloaded from storage");
});

test("device lists skip entries without ids and label unnamed devices", async () => {
  const capture = createCapture({ mediaDevices: devices(), storage: null });
  await capture.refreshDevices();
  const snapshot = capture.getSnapshot();
  assert.deepEqual(snapshot.inputDevices, [{ value: "mic-1", label: "Mic" }]);
  assert.deepEqual(snapshot.cameras, [{ value: "cam-1", label: "videoinput 1" }]);
  assert.deepEqual(snapshot.outputDevices, [{ value: "spk-1", label: "Speaker" }]);
});

test("storage failures never break capture", async () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const capture = createCapture({ mediaDevices: devices(), storage: throwing });
  assert.equal(capture.preferences.quality, "hd");
  capture.setPreference("quality", "vga");
  assert.equal(capture.preferences.quality, "vga");
});

test("overlapping acquires install only the newest track", async () => {
  const resolvers = [];
  const made = [];
  const capture = createCapture({
    storage: null,
    mediaDevices: {
      getUserMedia: () => new Promise((resolve) => resolvers.push(() => {
        const value = track("video");
        made.push(value);
        resolve({ getAudioTracks: () => [], getVideoTracks: () => [value], getTracks: () => [value] });
      })),
    },
  });
  const first = capture.acquire("camera");
  const second = capture.acquire("camera");
  resolvers[1]();
  resolvers[0]();
  const [older, newer] = await Promise.all([first, second]);
  assert.equal(capture.track("camera"), made[0], "second request resolved first and is the newest");
  assert.equal(newer, made[0]);
  assert.equal(made[1].stopped, true, "the stale result is stopped");
  assert.equal(older, made[0]);
});

test("release cancels an acquire in progress", async () => {
  let finish;
  const value = track("video");
  const capture = createCapture({
    storage: null,
    mediaDevices: { getUserMedia: () => new Promise((resolve) => (finish = () => resolve({ getAudioTracks: () => [], getVideoTracks: () => [value], getTracks: () => [value] }))) },
  });
  const pending = capture.acquire("camera");
  capture.release("camera");
  finish();
  assert.equal(await pending, null);
  assert.equal(value.stopped, true);
  assert.equal(capture.getSnapshot().cameraOn, false);
});

test("background preferences report the camera pipeline only while the camera is live", async () => {
  const capture = createCapture({ mediaDevices: devices(), storage: null });
  assert.equal(capture.setPreference("backgroundMode", "high"), "", "no camera yet");
  await capture.acquire("camera");
  assert.equal(capture.setPreference("backgroundMode", "low"), "background");
  for (const removed of ["image", "transparent", "sparkles"]) assert.throws(() => capture.setPreference("backgroundMode", removed), removed);
  assert.throws(() => capture.setPreference("backgroundImage", "default-3"), "image backgrounds were removed");
  assert.equal(capture.setPreference("noiseMode", "rnnoise"), "", "microphone not live");
});
