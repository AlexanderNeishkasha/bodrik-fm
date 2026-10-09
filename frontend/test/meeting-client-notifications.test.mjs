import assert from "node:assert/strict";
import { test } from "node:test";

import { createMeetingNotifications, notificationFor } from "../features/meeting/client/notifications.mjs";
import { createPreferences } from "../features/meeting/client/preferences.mjs";

const stamp = (sessionId) => ({ roomInstanceId: "r", sessionId, admissionEpoch: 1 });
const people = { me: { name: "Me" }, bob: { name: "Bob" } };
const state = { selfId: "me", presenter: true, language: "ru", participants: people };

test("events map to notification keys and sounds", () => {
  const cases = [
    ["someone joins", "participantJoined", { participant: stamp("bob") }, { key: "joined", sound: "joined", name: "Bob" }],
    ["unknown departure after refresh is silent", "participantLeft", { participant: stamp("old-session") }, null],
    ["self departure is silent", "participantLeft", { participant: stamp("me") }, null],
    ["missing departure identity is silent", "participantLeft", {}, null],
    ["self join is silent", "participantJoined", { participant: stamp("me") }, null],
    ["presenter granted to me", "presenter", { participant: stamp("me"), presenter: true, from: stamp("bob") }, { key: "presenterGranted", sound: "notify", from: "Bob" }],
    ["role change for others is silent", "presenter", { participant: stamp("bob"), presenter: true, from: stamp("me") }, null],
    ["moderation", "peerAction", { action: "mute", from: stamp("bob") }, { key: "mute", sound: "alert", severity: "warning", from: "Bob" }],
    ["eject has no toast (status screen)", "peerAction", { action: "eject", from: stamp("bob") }, null],
    ["lobby entrant for presenter", "roomLobby", { lobby_status: "waiting", peer_name: "Eve" }, { key: "lobby", sound: "lobby", name: "Eve" }],
    ["chat plays a sound only", "chatMessage", { sender: stamp("bob") }, { key: "", sound: "message" }],
    ["room lock", "roomAction", { action: "lock" }, { key: "lock", sound: "locked" }],
    ["unknown", "somethingElse", {}, null],
  ];
  for (const [name, kind, value, expected] of cases) assert.deepEqual(notificationFor(kind, value, state, state), expected, name);
});

test("a participant who left is named from the previous state", () => {
  const after = { ...state, participants: { me: people.me } };
  assert.deepEqual(notificationFor("participantLeft", { participant: stamp("bob") }, after, state), { key: "left", sound: "left", name: "Bob" });
});

test("toasts show localized text, expire, and meeting sounds remain enabled", () => {
  let current = state;
  const stateListeners = new Set();
  const events = new Set();
  const preferences = createPreferences({ storage: null });
  const client = {
    getState: () => current,
    subscribe: (listener) => (stateListeners.add(listener), () => stateListeners.delete(listener)),
    subscribeEvents: (listener) => (events.add(listener), () => events.delete(listener)),
    preferences,
  };
  const sounds = [];
  const timers = [];
  const notes = createMeetingNotifications({ client, playSound: (name) => sounds.push(name), schedule: (fn) => (timers.push(fn), timers.length), cancel() {} });
  const emit = (kind, value) => events.forEach((listener) => listener(kind, value));

  emit("participantJoined", { participant: stamp("bob") });
  assert.equal(notes.getSnapshot(), null, "join toast waits for the profile name");
  timers.at(-1)();
  assert.equal(notes.getSnapshot().text, "Bob присоединился к встрече");
  timers.at(-1)();
  assert.equal(notes.getSnapshot(), null);

  // Leave: state listeners run first, then the event.
  current = { ...state, participants: { me: people.me } };
  stateListeners.forEach((listener) => listener());
  emit("participantLeft", { participant: stamp("bob") });
  assert.equal(notes.getSnapshot().text, "Bob покинул встречу");

  assert.throws(() => preferences.set("sounds", false), /Invalid preference/);
  current = { ...current, language: "en" };
  emit("roomAction", { action: "unlock" });
  assert.equal(notes.getSnapshot().text, "The room password was removed");
  assert.deepEqual(sounds, ["joined", "left", "notify"]);
});
