import assert from "node:assert/strict";
import { test } from "node:test";

import { MUSIC_ID, initialRoomState, reduceRoomState, registryView } from "../features/meeting/client/roomState.mjs";

const stamp = (sessionId) => ({ roomInstanceId: "r1", sessionId, admissionEpoch: 1 });
const welcome = { type: "welcome", welcome: { stamp: stamp("me"), phase: "admitted", presenter: true } };
const snapshot = {
  type: "snapshot",
  snapshot: { revision: 3, count: 2, peers: [
    { stamp: stamp("me"), name: "Me", avatar: "", presenter: true },
    { stamp: stamp("bob"), name: "Bob", avatar: "", presenter: false },
  ] },
};
const event = (kind, value) => ({ type: "event", kind, value });
const mic = (producerId, owner, paused) => ({ producerId, participant: stamp(owner), name: "Bob", avatar: "", kind: "audio", mediaType: "audioType", ...(paused === undefined ? {} : { paused }) });
const music = { producerId: "m1", participant: { roomInstanceId: "system", sessionId: MUSIC_ID, admissionEpoch: 1 }, name: "Бодрик FM", kind: "audio", mediaType: "audioType", system: "music", volume: 0.4 };

/** Reduce a list of actions from the initial state. */
function run(...actions) {
  return actions.reduce(reduceRoomState, initialRoomState);
}

/** Registry participant by id. */
function viewOf(state, id) {
  return registryView(state).participants.find((value) => value.id === id);
}

test("welcome phases map to client status", () => {
  for (const [phase, status] of [["admitted", "admitted"], ["lobby", "lobby"], ["password", "password"], ["joinLocked", "joinLocked"], ["banned", "banned"], ["other", "denied"]]) {
    const state = run({ type: "welcome", welcome: { stamp: stamp("me"), phase, presenter: false } });
    assert.equal(state.status, status, phase);
    assert.equal(state.selfId, "me");
  }
});

test("participant events update the projection", () => {
  const cases = [
    ["join adds a participant", [event("participantJoined", { participant: stamp("eve"), name: "Eve", avatar: "", presenter: false, count: 3 })], (s) => s.participants.eve?.name === "Eve" && s.count === 3],
    ["leave removes the participant and its producers", [event("producerCreated", mic("p1", "bob")), event("participantLeft", { participant: stamp("bob"), count: 1 })], (s) => !s.participants.bob && !s.producers.p1 && s.count === 1],
    ["profile renames", [event("participantProfile", { participant: stamp("bob"), field: "name", value: "Robert" })], (s) => s.participants.bob.name === "Robert"],
    ["profile ignores unknown fields", [event("participantProfile", { participant: stamp("bob"), field: "role", value: "x" })], (s) => !("role" in s.participants.bob)],
    ["presenter change for self updates own role", [event("presenter", { participant: stamp("me"), presenter: false })], (s) => s.presenter === false && s.participants.me.presenter === false],
    ["presenter change for other keeps own role", [event("presenter", { participant: stamp("bob"), presenter: true })], (s) => s.presenter === true && s.participants.bob.presenter === true],
    ["unknown events are ignored", [event("somethingNew", { x: 1 })], (s) => Object.keys(s.participants).length === 2],
  ];
  for (const [name, actions, check] of cases) {
    assert.ok(check(run(welcome, snapshot, ...actions)), name);
  }
});

test("microphone state follows producer events", () => {
  const cases = [
    ["new producer is active", [event("producerCreated", mic("p1", "bob"))], true],
    ["inventory pause flag wins", [{ type: "inventory", sources: [mic("p1", "bob", true)] }], false],
    ["relayed pause mutes", [event("producerCreated", mic("p1", "bob")), event("producerState", { producerId: "p1", participant: stamp("bob"), paused: true })], false],
    ["relayed resume unmutes", [event("producerCreated", mic("p1", "bob", true)), event("producerState", { producerId: "p1", participant: stamp("bob"), paused: false })], true],
    ["change from a non-owner is ignored", [event("producerCreated", mic("p1", "bob")), event("producerState", { producerId: "p1", participant: stamp("eve"), paused: true })], true],
    ["early change before producerCreated is applied", [event("producerState", { producerId: "p1", participant: stamp("bob"), paused: true }), event("producerCreated", mic("p1", "bob"))], false],
    ["early change from another owner is not applied", [event("producerState", { producerId: "p1", participant: stamp("eve"), paused: true }), event("producerCreated", mic("p1", "bob"))], true],
    ["closed producer leaves no audio", [event("producerCreated", mic("p1", "bob")), event("producerClosed", { resourceId: "p1" })], false],
  ];
  for (const [name, actions, audio] of cases) {
    assert.equal(viewOf(run(welcome, snapshot, ...actions), "bob").audio, audio, name);
  }
});

test("early producer-state changes are bounded", () => {
  const changes = Array.from({ length: 100 }, (_, index) => event("producerState", { producerId: `x${index}`, participant: stamp("bob"), paused: true }));
  assert.equal(Object.keys(run(welcome, snapshot, ...changes).early).length, 64);
});

test("music participant follows the music producer", () => {
  const started = run(welcome, snapshot, event("producerCreated", music));
  assert.equal(viewOf(started, MUSIC_ID)?.bot, true);
  assert.equal(started.musicVolume, 0.4);
  assert.equal(viewOf(reduceRoomState(started, snapshot), MUSIC_ID)?.bot, true, "snapshot keeps music");
  assert.equal(viewOf(reduceRoomState(started, event("producerClosed", { resourceId: "m1" })), MUSIC_ID), undefined);
  assert.equal(viewOf(reduceRoomState(started, { type: "inventory", sources: [] }), MUSIC_ID), undefined, "inventory without music removes it");
});

test("snapshot replaces participants and drops orphaned producers", () => {
  const state = run(welcome, snapshot, event("producerCreated", mic("p1", "bob")), {
    type: "snapshot",
    snapshot: { count: 1, peers: [{ stamp: stamp("me"), name: "Me", presenter: false }] },
  });
  assert.deepEqual(Object.keys(state.participants), ["me"]);
  assert.equal(state.producers.p1, undefined);
  assert.equal(state.presenter, false);
});

test("registry view orders self first and music last and maps kinds", () => {
  const camera = { ...mic("v1", "bob"), kind: "video", mediaType: "videoType" };
  const state = run(welcome, snapshot, event("producerCreated", music), event("producerCreated", camera));
  const view = registryView(state);
  assert.deepEqual(view.participants.map((value) => value.id), ["me", "bob", MUSIC_ID]);
  assert.equal(viewOf(state, "bob").video, true);
  assert.deepEqual(view.sources.map((value) => [value.participantId, value.kind]), [[MUSIC_ID, "audio"], ["bob", "camera"]]);
});

test("unchanged events keep state identity", () => {
  const state = run(welcome, snapshot, event("producerCreated", mic("p1", "bob")));
  assert.equal(reduceRoomState(state, event("producerState", { producerId: "p1", participant: stamp("bob"), paused: false })), state);
  assert.equal(reduceRoomState(state, { type: "unknown" }), state);
});

test("registry view omits sources until their participant is known", () => {
  const before = run(welcome, { type: "localProducer", id: "own-mic", kind: "audio" });
  assert.deepEqual(registryView(before).sources, []);
  const after = reduceRoomState(before, snapshot);
  assert.deepEqual(registryView(after).sources.map((value) => [value.id, value.local]), [["own-mic", true]]);
  assert.equal(viewOf(after, "me").audio, true);
  assert.equal(viewOf(reduceRoomState(after, { type: "localProducer", id: "own-mic", kind: "audio", paused: true }), "me").audio, false);
  assert.equal(registryView(reduceRoomState(after, { type: "localProducerClosed", id: "own-mic" })).sources.length, 0);
});

test("the room counts as loaded once the first inventory arrives", () => {
  const cases = [
    ["initially not loaded", [], false],
    ["snapshot alone is not enough", [{ type: "snapshot", snapshot: { revision: 0, count: 0, peers: [] } }], false],
    ["inventory loads the room", [{ type: "inventory", sources: [] }], true],
  ];
  for (const [name, actions, expected] of cases) {
    const state = actions.reduce(reduceRoomState, initialRoomState);
    assert.equal(state.loaded, expected, name);
  }
});
