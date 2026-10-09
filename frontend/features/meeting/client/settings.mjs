import { createMicrophoneComparison } from "./microphoneComparison.mjs";
import { createInputLevelMeter } from "./inputLevelMeter.mjs";
import { create as createShellModel, sections as allSections } from "../settings/settingsShellModel.mjs";
import { FRAME_RATES, RESOLUTIONS, SCREEN_HINTS } from "./capture.mjs";
import { backgroundSupported, noiseSuppressionSupported } from "./processing.mjs";

/** Capture preference keys the audio and video views may change. */
const AUDIO_KEYS = Object.freeze(["inputDevice", "outputDevice", "noiseMode", "echoCancellation", "autoGainControl"]);
const VIDEO_KEYS = Object.freeze(["camera", "quality", "frameRate", "screenQuality", "screenFrameRate", "screenHint"]);

/** Moderator policy fields (Rust `Moderator`). */
const MODERATOR_FIELDS = Object.freeze(["audio_start_muted", "video_start_hidden", "audio_cant_unmute", "video_cant_unhide", "screen_cant_share", "chat_cant_privately", "chat_cant_publicly"]);

/** Room policy toggles mapped to Rust room-control actions. */
const ROOM_TOGGLES = Object.freeze({ joinLock: "joinLock", lobby: "lobby" });

/** `roomAction` relay values mapped to config changes. */
const ROOM_EVENTS = Object.freeze({
  lock: ["isLocked", true], unlock: ["isLocked", false],
  lobbyOn: ["isLobbyEnabled", true], lobbyOff: ["isLobbyEnabled", false],
  joinLockOn: ["isJoinLocked", true], joinLockOff: ["isJoinLocked", false],
});

/** Camera effects shown by the video view and the camera menu (labels are localized there). */
const EFFECT_OPTIONS = Object.freeze(["off", "low", "high"].map((value) => Object.freeze({ value, label: value })));

/** Option lists shown by the video view. */
const QUALITY_OPTIONS = Object.freeze(Object.entries(RESOLUTIONS).map(([value, [width, height]]) => Object.freeze({ value, label: `${value.toUpperCase()} (${width}×${height})` })));
const RATE_OPTIONS = Object.freeze(FRAME_RATES.map((value) => Object.freeze({ value, label: value === "max" ? "Max" : `${value} fps` })));
const HINT_OPTIONS = Object.freeze(SCREEN_HINTS.map((value) => Object.freeze({ value, label: value })));

/** Shallow equality of two plain objects. */
function same(a, b) {
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * A settings source: `compute()` derives the snapshot from the client's stores;
 * `execute(key, value)` runs one command with pending/error bookkeeping.
 */
function source(stores, compute, run, extra = {}, tracksPending = () => true) {
  const listeners = new Set();
  let pending = null;
  let error = "";
  let snapshot = null;
  /** Recompute and publish when changed. */
  function refresh() {
    const next = { ...compute(), pending, error };
    if (same(next, snapshot)) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  }
  const offs = stores.map((store) => store.subscribe(refresh));
  refresh();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async execute(key, value) {
      if (pending) throw new Error("Setting update already pending");
      const tracked = tracksPending(key);
      if (tracked) pending = key;
      error = "";
      refresh();
      try {
        return await run(key, value);
      } catch (failure) {
        error = failure?.code === "unknown_outcome" ? "unknown_outcome" : "rejected";
        throw failure;
      } finally {
        if (tracked) pending = null;
        refresh();
      }
    },
    dispose: () => offs.forEach((off) => off()),
    ...extra,
  };
}

/** Room header source: slug, invite and time since joining (the view ticks the timer). */
function roomInfoSource(stores, room, language, onShare) {
  let joinedAt = 0;
  let snapshot = null;
  const listeners = new Set();
  /** Recompute when room status or language changes. */
  function refresh() {
    const state = room();
    if (state.status === "admitted" && !joinedAt) joinedAt = Date.now();
    const next = { language: language(), available: state.status === "admitted", joinedAt };
    if (snapshot && snapshot.language === next.language && snapshot.available === next.available && snapshot.joinedAt === next.joinedAt) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  }
  const offs = stores.map((store) => store.subscribe(refresh));
  refresh();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    /** "share" opens the invite dialog. */
    async execute(key) {
      if (key !== "share") throw new Error("Unsupported room action");
      onShare?.();
    },
    dispose: () => offs.forEach((off) => off()),
  };
}

/** Avatar the prejoin restores on the next join (`MeetingPrejoin`); "" forgets it. */
function rememberAvatar(url) {
  try {
    if (url) globalThis.localStorage?.setItem("meeting.avatar", url);
    else globalThis.localStorage?.removeItem("meeting.avatar");
  } catch {
    // Storage may be unavailable (private mode); the change still applies to this meeting.
  }
}

/** Immutable policy view state. */
function freezePolicy(policy) {
  return Object.freeze({ config: Object.freeze({ ...policy.config }), moderator: Object.freeze({ ...policy.moderator }) });
}

/** Policy capabilities: every control exists; only presenters may change them. */
function freezeCapabilities(presenter) {
  return Object.freeze({ presenter, joinLock: true, lobby: true, password: true, moderator: true });
}

/** Browser and device details shown in the profile view. */
function technicalDetails(navigatorRef) {
  const agent = navigatorRef?.userAgentData;
  const rows = [
    ["browser", agent?.brands?.map((brand) => `${brand.brand} ${brand.version}`) || [navigatorRef?.userAgent || ""]],
    ["os", [agent?.platform || navigatorRef?.platform || ""]],
    ["cpu", [navigatorRef?.hardwareConcurrency ? `${navigatorRef.hardwareConcurrency} cores` : ""]],
    ["device", [agent?.mobile ? "mobile" : "desktop"]],
  ];
  return Object.freeze(rows.map(([key, values]) => Object.freeze({ key, values: Object.freeze(values.filter(Boolean).slice(0, 4)) })).filter((row) => row.values.length));
}

/**
 * Settings shell and feature sources for the React settings workspace, backed by the
 * meeting client: capture devices, room/moderator policy, profile and
 * personal preferences.
 */
export function createMeetingSettings({ client, navigatorRef = globalThis.navigator, AudioContextImpl = globalThis.AudioContext, playTone, speakerTest, onShare }) {
  const { capture, layout, preferences } = client;
  const stores = [client, capture, layout, preferences];
  const room = () => client.getState();
  const language = () => preferences.getSnapshot().language;
  let policy = { config: { isLocked: false, isLobbyEnabled: false, isJoinLocked: false }, moderator: Object.fromEntries(MODERATOR_FIELDS.map((key) => [key, false])) };
  const policyListeners = new Set();
  const policyStore = { subscribe: (listener) => (policyListeners.add(listener), () => policyListeners.delete(listener)) };

  let policyState = freezePolicy(policy);

  /** Replace policy from a command result or relay and notify. */
  function setPolicy(next) {
    policy = { config: { ...policy.config, ...(next.config || {}) }, moderator: { ...policy.moderator, ...(next.moderator || {}) } };
    policyState = freezePolicy(policy);
    for (const listener of [...policyListeners]) listener();
  }
  const capabilities = { true: freezeCapabilities(true), false: freezeCapabilities(false) };
  const offEvents = client.subscribeEvents((kind, value) => {
    if (kind === "roomAction" && ROOM_EVENTS[value?.action]) {
      const [field, status] = ROOM_EVENTS[value.action];
      setPolicy({ config: { [field]: status } });
    } else if (kind === "moderator" && value && typeof value === "object") {
      setPolicy({ moderator: Object.fromEntries(MODERATOR_FIELDS.filter((key) => typeof value[key] === "boolean").map((key) => [key, value[key]])) });
    }
  });

  // Presenter-only ban list; null until loaded. Rows carry an opaque id, name and expiry.
  let bans = null;
  /** Replace the ban list from a `{bans}` command result and notify. */
  const setBans = (value) => {
    if (!Array.isArray(value?.bans)) throw new Error("Invalid ban list");
    bans = Object.freeze(value.bans.map((row) => Object.freeze({ id: String(row.id), name: String(row.name || ""), expiresIn: Number(row.expiresIn) || 0 })));
    for (const listener of [...policyListeners]) listener();
  };

  /** Apply a policy-shaped command result. */
  const applyResult = (value) => {
    if (value?.config || value?.moderator) setPolicy(value);
    return value;
  };

  const inputMeter = createInputLevelMeter({ capture, AudioContextImpl });

  const audio = source(speakerTest ? [...stores, speakerTest] : stores, () => {
    const value = capture.getSnapshot();
    return {
      language: language(),
      microphoneAvailable: value.microphone,
      inputDevices: value.inputDevices,
      inputDevice: value.inputDevice || value.activeInputDevice,
      outputDevices: value.outputDevices,
      outputDevice: value.outputDevice,
      outputSelectionAvailable: typeof globalThis.HTMLMediaElement?.prototype?.setSinkId === "function",
      noiseMode: value.noiseMode,
      enhancedAvailable: noiseSuppressionSupported(),
      processingAvailable: true,
      echoCancellation: value.echoCancellation,
      autoGainControl: value.autoGainControl,
      pttAvailable: false,
      pushToTalk: false,
      focusAvailable: false,
      speakerFocus: false,
      speakerVolume: preferences.getSnapshot().masterVolume,
      speakerTestPlaying: speakerTest?.getSnapshot() || false,
      volumeAvailable: true,
      volumeError: false,
    };
  }, async (key, value) => {
    if (key === "testSpeaker") {
      if (speakerTest?.getSnapshot()) return speakerTest.stop();
      return speakerTest ? speakerTest.play(capture.getSnapshot().outputDevice) : playTone?.(capture.getSnapshot().outputDevice);
    }
    if (!AUDIO_KEYS.includes(key)) throw new Error("Unsupported audio setting");
    return client.setCapturePreference(key, value);
  }, {
    getInputLevel: inputMeter.getSnapshot,
    subscribeLevel: inputMeter.subscribe,
    /** Create an idle comparison store; its menu subscription owns temporary microphone probes. */
    createInputComparison: () => createMicrophoneComparison({ capture, mediaDevices: navigatorRef?.mediaDevices, AudioContextImpl }),
    /** Master speaker volume (0–100); persisted when `persist` is true. */
    setVolume(value, persist = false) {
      if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("Invalid output volume");
      if (persist || value !== preferences.getSnapshot().masterVolume) preferences.set("masterVolume", value);
    },
  }, (key) => key !== "testSpeaker");

  const video = source([...stores, policyStore], () => {
    const value = capture.getSnapshot();
    return {
      language: language(),
      cameras: value.cameras,
      camera: value.camera || value.activeCamera,
      qualities: QUALITY_OPTIONS,
      quality: value.quality,
      frameRates: RATE_OPTIONS,
      frameRate: value.frameRate,
      screenQualities: QUALITY_OPTIONS,
      screenQuality: value.screenQuality,
      screenFrameRates: RATE_OPTIONS,
      screenFrameRate: value.screenFrameRate,
      screenHints: HINT_OPTIONS,
      screenHint: value.screenHint,
      screenHintAvailable: value.screen,
      screenAvailable: value.screenAvailable,
      cameraAllowed: !(policy.moderator.video_cant_unhide && !room().presenter),
      effects: EFFECT_OPTIONS,
      effect: value.backgroundMode,
      effectSupported: backgroundSupported(),
      accessStatus: value.error === "camera" ? "camera" : "",
      accessPending: false,
    };
  }, async (key, value) => {
    if (key === "requestAccess") return client.preview("camera", true);
    if (key === "effect") {
      if (!EFFECT_OPTIONS.some((option) => option.value === value)) throw new Error("Invalid camera effect");
      return client.setCapturePreference("backgroundMode", value);
    }
    if (!VIDEO_KEYS.includes(key)) throw new Error("Unsupported video setting");
    return client.setCapturePreference(key, value);
  });

  let avatar = "";
  const details = technicalDetails(navigatorRef);
  const profile = source(stores, () => {
    const self = room().participants[room().selfId];
    return {
      language: language(),
      available: room().status === "admitted",
      name: self?.name || "",
      avatar: self?.avatar || avatar,
      customAvatar: Boolean(self?.avatar),
      presenter: room().presenter,
      details,
    };
  }, async (key, value) => {
    if (key === "name") {
      const name = typeof value === "string" ? value.trim() : "";
      if (!name || name.length > 32) throw new Error("Invalid name");
      return client.command({ type: "participantProfile", change: { type: "name", value: name } });
    }
    if (key === "avatar") {
      const url = await client.uploadImage("avatar", value);
      avatar = new URL(url).pathname;
      const result = await client.command({ type: "participantProfile", change: { type: "avatar", value: avatar } });
      rememberAvatar(avatar);
      return result;
    }
    if (key === "resetAvatar") {
      avatar = "";
      const result = await client.command({ type: "participantProfile", change: { type: "avatar", value: "" } });
      rememberAvatar("");
      return result;
    }
    throw new Error("Unsupported profile setting");
  });

  const policySource = source([...stores, policyStore], () => ({
    language: language(),
    available: room().status === "admitted",
    capabilities: capabilities[room().presenter === true],
    state: policyState,
    bans,
  }), async (key, value) => {
    if (key === "loadBans") return setBans(await client.command({ type: "roomControl", action: { type: "bans" } }));
    if (key === "unban") {
      if (typeof value !== "string" || !value) throw new Error("Invalid ban");
      return setBans(await client.command({ type: "roomControl", action: { type: "unban", id: value } }));
    }
    if (Object.hasOwn(ROOM_TOGGLES, key)) {
      if (typeof value !== "boolean") throw new Error("Invalid policy value");
      return applyResult(await client.command({ type: "roomControl", action: { type: ROOM_TOGGLES[key], status: value } }));
    }
    if (key === "password") {
      if (typeof value !== "string" || !value.trim()) throw new Error("Invalid password");
      return applyResult(await client.command({ type: "roomControl", action: { type: "lock", password: value } }));
    }
    if (key === "unlock") return applyResult(await client.command({ type: "roomControl", action: { type: "unlock" } }));
    if (MODERATOR_FIELDS.includes(key)) {
      if (typeof value !== "boolean") throw new Error("Invalid policy value");
      return applyResult(await client.command({ type: "moderator", change: { type: "one", field: key, status: value } }));
    }
    throw new Error("Unsupported policy setting");
  });

  const personal = source(stores, () => ({
    language: language(),
    shortcuts: preferences.getSnapshot().shortcuts,
  }), async (key, value) => {
    if (key === "language" || key === "shortcuts") return preferences.set(key, value);
    throw new Error("Unsupported personal setting");
  });

  const shell = createShellModel({
    // Moderator settings are presenter-only; everything else is always listed.
    getAvailableSections: () => allSections.filter((id) => id !== "tabModerator" || room().presenter),
    getLanguage: language,
  });
  const offShell = stores.map((store) => store.subscribe(() => shell.refresh()));
  // Settings panels stay mounted while hidden, so the ban list reloads here each time a
  // presenter opens the dialog on the moderator tab, rather than from a view effect.
  let moderatorShown = false;
  offShell.push(shell.subscribe(() => {
    const { open, selected } = shell.getSnapshot();
    const shown = open && selected === "tabModerator" && room().presenter === true;
    if (shown && !moderatorShown) policySource.execute("loadBans").catch(() => {});
    moderatorShown = shown;
  }));

  const sources = Object.freeze({ audio, video, profile, policy: policySource, personal, roomInfo: roomInfoSource(stores, room, language, onShare) });
  return {
    shell,
    sources,
    /** Open the settings dialog. */
    open: () => shell.execute("open"),
    /** Open the settings dialog on one section. */
    openSection(section) {
      if (shell.getSnapshot().available.includes(section)) shell.execute("select", section);
      shell.execute("open");
    },
    /** Stop observing and release the level meter. */
    dispose() {
      inputMeter.dispose();
      offEvents();
      offShell.forEach((off) => off());
      Object.values(sources).forEach((value) => value.dispose());
      shell.dispose?.();
    },
  };
}
