/** Capture resolutions offered by the legacy meeting, keyed by option value. */
export const RESOLUTIONS = Object.freeze({
  qvga: [320, 240],
  vga: [640, 480],
  hd: [1280, 720],
  fhd: [1920, 1080],
  "2k": [2560, 1440],
  "4k": [3840, 2160],
});

/** Frame-rate option values ("max" leaves the rate to the browser). */
export const FRAME_RATES = Object.freeze(["max", "60", "30", "15", "5"]);

/** Screen content hints supported by browsers. */
export const SCREEN_HINTS = Object.freeze(["detail", "text", "motion"]);

/** Persisted preference defaults. */
export const DEFAULT_PREFERENCES = Object.freeze({
  inputDevice: "",
  outputDevice: "",
  camera: "",
  noiseMode: "browser",
  echoCancellation: true,
  autoGainControl: true,
  quality: "hd",
  frameRate: "30",
  screenQuality: "fhd",
  screenFrameRate: "30",
  screenHint: "detail",
  backgroundMode: "off",
});

/** localStorage key for capture preferences. */
const STORAGE_KEY = "meeting.capture.v1";

/** Validators for each preference command. */
const VALID = Object.freeze({
  inputDevice: (value) => typeof value === "string" && value.length <= 256,
  outputDevice: (value) => typeof value === "string" && value.length <= 256,
  camera: (value) => typeof value === "string" && value.length <= 256,
  noiseMode: (value) => value === "off" || value === "browser" || value === "rnnoise",
  echoCancellation: (value) => typeof value === "boolean",
  autoGainControl: (value) => typeof value === "boolean",
  quality: (value) => Object.hasOwn(RESOLUTIONS, value),
  frameRate: (value) => FRAME_RATES.includes(value),
  screenQuality: (value) => Object.hasOwn(RESOLUTIONS, value),
  screenFrameRate: (value) => FRAME_RATES.includes(value),
  screenHint: (value) => SCREEN_HINTS.includes(value),
  backgroundMode: (value) => ["off", "low", "high"].includes(value),
});

/** Which live capture a preference change must restart ("output" means sink only). */
const AFFECTS = Object.freeze({
  inputDevice: "audio",
  noiseMode: "audio",
  echoCancellation: "audio",
  autoGainControl: "audio",
  camera: "camera",
  quality: "camera",
  frameRate: "camera",
  outputDevice: "output",
  backgroundMode: "background",
});

/** Merge stored preferences over defaults, dropping invalid values. */
export function parsePreferences(raw) {
  let stored = {};
  try {
    stored = raw ? JSON.parse(raw) : {};
  } catch {
    stored = {};
  }
  const valid = Object.entries(stored ?? {}).filter(([key, value]) => VALID[key]?.(value));
  return Object.freeze({ ...DEFAULT_PREFERENCES, ...Object.fromEntries(valid) });
}

/** Video constraints for a resolution/frame-rate pair. */
function videoConstraints(quality, frameRate, fallback) {
  const [width, height] = RESOLUTIONS[quality] || RESOLUTIONS[fallback];
  const rate = Number.parseInt(frameRate, 10);
  return { width: { ideal: width }, height: { ideal: height }, ...(rate ? { frameRate: { ideal: rate } } : {}) };
}

/** getUserMedia/getDisplayMedia constraints for one source kind. */
export function captureConstraints(kind, preferences) {
  if (kind === "audio") {
    return {
      audio: {
        ...(preferences.inputDevice ? { deviceId: { exact: preferences.inputDevice } } : {}),
        echoCancellation: preferences.echoCancellation,
        autoGainControl: preferences.autoGainControl,
        noiseSuppression: preferences.noiseMode === "browser",
      },
    };
  }
  if (kind === "camera") {
    return {
      video: {
        ...videoConstraints(preferences.quality, preferences.frameRate, "hd"),
        ...(preferences.camera ? { deviceId: { exact: preferences.camera } } : {}),
      },
    };
  }
  if (kind === "screen") {
    return { audio: true, video: videoConstraints(preferences.screenQuality, preferences.screenFrameRate, "fhd") };
  }
  throw new Error("Unknown capture kind");
}

/** Bounded device option list for one device kind. */
function deviceOptions(devices, kind) {
  return Object.freeze(devices
    .filter((device) => device.kind === kind && device.deviceId)
    .slice(0, 64)
    .map((device, index) => Object.freeze({ value: device.deviceId, label: (device.label || `${kind} ${index + 1}`).slice(0, 128) })));
}

/**
 * Own every local capture track and the capture preferences. Callers publish the
 * returned tracks; this module only acquires, restarts and stops them.
 */
export function createCapture({ mediaDevices, storage }) {
  let preferences = parsePreferences(read(storage));
  let devices = Object.freeze({ inputDevices: [], outputDevices: [], cameras: [] });
  const tracks = new Map(); // kind -> MediaStreamTrack
  const generations = new Map(); // kind -> latest acquire number
  const active = { audio: "", camera: "" }; // device ids of the live tracks
  const listeners = new Set();
  let snapshot = null;
  let pending = "";
  let error = "";

  /** Publish a new immutable snapshot. */
  function publish() {
    snapshot = Object.freeze({
      ...preferences,
      ...devices,
      activeInputDevice: active.audio,
      activeCamera: active.camera,
      microphone: tracks.has("audio"),
      cameraOn: tracks.has("camera"),
      screen: tracks.has("screen"),
      screenAvailable: typeof mediaDevices?.getDisplayMedia === "function",
      pending,
      error,
    });
    for (const listener of [...listeners]) listener();
  }

  /** Persist preferences, ignoring unavailable storage. */
  function save() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Private mode or blocked storage: keep in memory only.
    }
  }

  publish();

  const api = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Current preferences. */
    get preferences() {
      return preferences;
    },
    /** Live track for a kind, or null. */
    track: (kind) => tracks.get(kind) || null,

    /** Re-read device lists (labels appear after a permission grant). */
    async refreshDevices() {
      const list = (await mediaDevices.enumerateDevices?.()) || [];
      devices = Object.freeze({
        inputDevices: deviceOptions(list, "audioinput"),
        outputDevices: deviceOptions(list, "audiooutput"),
        cameras: deviceOptions(list, "videoinput"),
      });
      publish();
    },

    /**
     * Acquire (or re-acquire) one kind; the previous track of that kind is stopped.
     * When acquires of one kind overlap, only the newest is installed; an older one
     * stops its own track and resolves with whatever is current.
     */
    async acquire(kind) {
      const generation = (generations.get(kind) || 0) + 1;
      generations.set(kind, generation);
      const constraints = captureConstraints(kind, preferences);
      const stream = kind === "screen" ? await mediaDevices.getDisplayMedia(constraints) : await mediaDevices.getUserMedia(constraints);
      const track = kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      // Screen capture may include system audio; this client publishes screen video only.
      for (const extra of stream.getTracks()) if (extra !== track) extra.stop();
      if (generations.get(kind) !== generation) {
        track.stop();
        return tracks.get(kind) || null;
      }
      if (kind === "screen" && "contentHint" in track) track.contentHint = preferences.screenHint;
      if (kind in active) active[kind] = track.getSettings?.().deviceId || "";
      const previous = tracks.get(kind);
      tracks.set(kind, track);
      previous?.stop();
      error = "";
      publish();
      return track;
    },

    /** Stop and forget one kind (also cancels an acquire still in progress). */
    release(kind) {
      generations.set(kind, (generations.get(kind) || 0) + 1);
      const track = tracks.get(kind);
      if (!track) return;
      tracks.delete(kind);
      track.stop();
      publish();
    },

    /**
     * Validate and store one preference. Returns the live capture it affects
     * ("audio", "camera", "output") or "" when nothing live needs to change.
     */
    setPreference(key, value) {
      if (!VALID[key]?.(value)) throw new Error("Invalid capture preference");
      if (preferences[key] === value) return "";
      preferences = Object.freeze({ ...preferences, [key]: value });
      save();
      if (key === "screenHint" && tracks.get("screen") && "contentHint" in tracks.get("screen")) tracks.get("screen").contentHint = value;
      publish();
      const affected = AFFECTS[key] || "";
      if (affected === "background") return tracks.has("camera") ? "background" : "";
      return affected === "output" || tracks.has(affected) ? affected : "";
    },

    /** Mark a command pending/failed for views. */
    setStatus(nextPending, nextError = "") {
      pending = nextPending;
      error = nextError;
      publish();
    },

    /** Stop every capture track. */
    stopAll() {
      for (const track of tracks.values()) track.stop();
      tracks.clear();
      publish();
    },
  };
  return api;
}

/** Read stored preferences, ignoring unavailable storage. */
function read(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}
