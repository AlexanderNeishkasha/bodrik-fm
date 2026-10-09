import assert from "node:assert/strict";
import { test } from "node:test";

import { createLayout } from "../features/meeting/client/layout.mjs";
import { createPreferences } from "../features/meeting/client/preferences.mjs";
import { createMeetingSettings } from "../features/meeting/client/settings.mjs";

/** Minimal observable store. */
function store(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    set(next) {
      snapshot = { ...snapshot, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

/** Fake client exposing the stores and calls settings use. */
function fakeClient({ presenter = true } = {}) {
  const state = store({ status: "admitted", selfId: "me", presenter, participants: { me: { id: "me", name: "Me", avatar: "" } } });
  const capture = Object.assign(store({ inputDevices: [], outputDevices: [], cameras: [], inputDevice: "", activeInputDevice: "mic-1", outputDevice: "", camera: "", activeCamera: "cam-1", noiseMode: "browser", echoCancellation: true, autoGainControl: true, quality: "hd", frameRate: "30", screenQuality: "fhd", screenFrameRate: "30", screenHint: "detail", screen: false, screenAvailable: true, cameraOn: true, microphone: true, error: "" }), { track: () => null });
  const events = new Set();
  const commands = [];
  const preferenceCalls = [];
  return {
    commands,
    preferenceCalls,
    getState: state.getSnapshot,
    subscribe: state.subscribe,
    setState: state.set,
    capture,
    layout: createLayout(),
    preferences: createPreferences({ storage: null }),
    subscribeEvents: (listener) => (events.add(listener), () => events.delete(listener)),
    emit: (kind, value) => events.forEach((listener) => listener(kind, value)),
    async command(action) {
      commands.push(action);
      if (action.type === "roomControl") return { config: { isLobbyEnabled: action.action.status === true }, moderator: {} };
      return {};
    },
    async setCapturePreference(key, value) {
      preferenceCalls.push([key, value]);
    },
    async uploadImage() {
      return "https://x.test/uploads/avatars/00000000-0000-0000-0000-000000000000.png";
    },
    async preview() {},
    backgroundImages: () => [{ id: "default-1", url: "/b1.jpg" }],
    addBackground: () => "custom-1",
    removeBackground() {},
  };
}

test("audio and video settings show active devices and change capture preferences", async () => {
  const client = fakeClient();
  const { sources } = createMeetingSettings({ client, navigatorRef: {} });
  assert.equal(sources.audio.getSnapshot().inputDevice, "mic-1", "active device when no preference");
  assert.equal(sources.video.getSnapshot().camera, "cam-1");
  await sources.audio.execute("noiseMode", "off");
  await sources.video.execute("quality", "fhd");
  assert.deepEqual(client.preferenceCalls, [["noiseMode", "off"], ["quality", "fhd"]]);
  await assert.rejects(sources.audio.execute("unknown", 1));
  assert.equal(sources.audio.getSnapshot().error, "rejected");
  sources.audio.setVolume(40, true);
  assert.equal(sources.audio.getSnapshot().speakerVolume, 40);
});

test("policy commands map to Rust actions and results update state", async () => {
  const client = fakeClient();
  const { sources } = createMeetingSettings({ client, navigatorRef: {} });
  const cases = [
    ["lobby", true, { type: "roomControl", action: { type: "lobby", status: true } }],
    ["joinLock", false, { type: "roomControl", action: { type: "joinLock", status: false } }],
    ["password", "secret", { type: "roomControl", action: { type: "lock", password: "secret" } }],
    ["unlock", undefined, { type: "roomControl", action: { type: "unlock" } }],
    ["chat_cant_privately", true, { type: "moderator", change: { type: "one", field: "chat_cant_privately", status: true } }],
  ];
  for (const [key, value, expected] of cases) {
    await sources.policy.execute(key, value);
    assert.deepEqual(client.commands.at(-1), expected, key);
  }
  assert.equal(sources.policy.getSnapshot().state.config.isLobbyEnabled, false, "last roomControl result applied");
  await assert.rejects(sources.policy.execute("lobby", "yes"));
});

test("policy follows room relays and gates camera for non-presenters", () => {
  const client = fakeClient({ presenter: false });
  const { sources } = createMeetingSettings({ client, navigatorRef: {} });
  client.emit("moderator", { video_cant_unhide: true, bogus: true });
  assert.equal(sources.policy.getSnapshot().state.moderator.video_cant_unhide, true);
  assert.equal("bogus" in sources.policy.getSnapshot().state.moderator, false);
  assert.equal(sources.video.getSnapshot().cameraAllowed, false);
});

test("unchanged stores keep snapshot identity", () => {
  const client = fakeClient();
  const { sources } = createMeetingSettings({ client, navigatorRef: {} });
  const before = sources.policy.getSnapshot();
  client.setState({ status: "admitted" });
  assert.equal(sources.policy.getSnapshot(), before);
});

test("profile and personal commands", async () => {
  const client = fakeClient();
  const { sources, shell } = createMeetingSettings({ client, navigatorRef: {} });
  await sources.profile.execute("name", "  New  ");
  assert.deepEqual(client.commands.at(-1), { type: "participantProfile", change: { type: "name", value: "New" } });
  await sources.profile.execute("avatar", { type: "image/png" });
  assert.equal(client.commands.at(-1).change.value, "/uploads/avatars/00000000-0000-0000-0000-000000000000.png");
  await assert.rejects(sources.profile.execute("name", " "));
  await sources.personal.execute("language", "en");
  assert.equal(client.preferences.getSnapshot().language, "en");
  await assert.rejects(sources.personal.execute("participantView", "speaker-left"));
  assert.equal(shell.getSnapshot().language, "en");
});

test("moderator settings are listed only for presenters", () => {
  const presenter = createMeetingSettings({ client: fakeClient(), navigatorRef: {} }).shell.getSnapshot().available;
  const guestClient = fakeClient({ presenter: false });
  const guest = createMeetingSettings({ client: guestClient, navigatorRef: {} }).shell;
  assert.ok(presenter.includes("tabModerator"));
  assert.ok(!guest.getSnapshot().available.includes("tabModerator"));
  guestClient.setState({ presenter: true });
  assert.ok(guest.getSnapshot().available.includes("tabModerator"), "promotion refreshes the shell");
});

test("presenter ban list loads and unbans through room control", async () => {
  const client = fakeClient();
  const list = [{ id: "ban-1", name: "Eve", expiresIn: 7200 }];
  client.command = async (action) => {
    client.commands.push(action);
    if (action.action?.type === "unban") list.splice(0);
    return { bans: list.slice() };
  };
  const { sources } = createMeetingSettings({ client, navigatorRef: {} });
  assert.equal(sources.policy.getSnapshot().bans, null, "not loaded yet");
  const cases = [
    ["loadBans", undefined, { type: "roomControl", action: { type: "bans" } }, [{ id: "ban-1", name: "Eve", expiresIn: 7200 }]],
    ["unban", "ban-1", { type: "roomControl", action: { type: "unban", id: "ban-1" } }, []],
  ];
  for (const [key, value, command, bans] of cases) {
    await sources.policy.execute(key, value);
    assert.deepEqual(client.commands.at(-1), command, key);
    assert.deepEqual(sources.policy.getSnapshot().bans, bans, key);
  }
  await assert.rejects(sources.policy.execute("unban", ""), /Invalid ban/);
  client.command = async () => ({});
  await assert.rejects(sources.policy.execute("loadBans"), /Invalid ban list/);
});

test("opening the moderator tab reloads the ban list for presenters only", async () => {
  for (const [name, presenter, expected] of [["presenter", true, 1], ["guest", false, 0]]) {
    const client = fakeClient({ presenter });
    const settings = createMeetingSettings({ client, navigatorRef: {} });
    const loads = () => client.commands.filter((command) => command.action?.type === "bans").length;
    assert.equal(loads(), 0, `${name}: nothing loaded while closed`);
    if (presenter) settings.openSection("tabModerator");
    else settings.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loads(), expected, name);
  }
});

test("camera effect is a video setting with only none, light and strong blur", async () => {
  const client = fakeClient();
  const { sources } = createMeetingSettings({ client, navigatorRef: {} });
  assert.deepEqual(sources.video.getSnapshot().effects.map((option) => option.value), ["off", "low", "high"]);
  assert.equal(sources.background, undefined, "no separate background section");
  for (const [name, value, expected] of [["light blur", "low", "low"], ["strong blur", "high", "high"], ["off", "off", "off"]]) {
    await sources.video.execute("effect", value);
    assert.deepEqual(client.preferenceCalls.at(-1), ["backgroundMode", expected], name);
  }
  for (const removed of ["image", "transparent"]) await assert.rejects(sources.video.execute("effect", removed), /Invalid camera effect/);
});


test("speaker test playback does not mark settings pending and toggles off", async () => {
  const client = fakeClient();
  let resolvePlay;
  let playing = false;
  const listeners = new Set();
  const speakerTest = {
    getSnapshot: () => playing,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    play() { playing = true; listeners.forEach((listener) => listener()); return new Promise((resolve) => { resolvePlay = resolve; }); },
    stop() { playing = false; listeners.forEach((listener) => listener()); resolvePlay(); },
  };
  const settings = createMeetingSettings({ client, speakerTest });
  const audio = settings.sources.audio;
  const play = audio.execute("testSpeaker");
  assert.equal(audio.getSnapshot().pending, null);
  assert.equal(audio.getSnapshot().speakerTestPlaying, true);
  await audio.execute("testSpeaker");
  await play;
  assert.equal(audio.getSnapshot().speakerTestPlaying, false);
  settings.dispose();
});


test("removed recording settings have no source, section or policy command", async () => {
  const client = fakeClient();
  const settings = createMeetingSettings({ client, navigatorRef: {} });
  assert.equal(Object.hasOwn(settings.sources, "recording"), false);
  assert.equal(settings.shell.getSnapshot().available.includes("tabRecording"), false);
  assert.equal(Object.hasOwn(settings.sources.policy.getSnapshot().state.config, "hostOnlyRecording"), false);
  await assert.rejects(settings.sources.policy.execute("hostOnly", true), /Unsupported policy setting/);
  assert.deepEqual(client.commands, []);
  settings.dispose();
});

test("profile avatars persist a reusable path and removal clears it", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  } });
  try {
    const sources = createMeetingSettings({ client: fakeClient(), navigatorRef: {} });
    await sources.sources.profile.execute("avatar", { type: "image/png" });
    assert.equal(values.get("meeting.avatar"), "/uploads/avatars/00000000-0000-0000-0000-000000000000.png");
    await sources.sources.profile.execute("resetAvatar");
    assert.equal(values.has("meeting.avatar"), false);
    sources.dispose();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});
