import assert from "node:assert/strict";
import { test } from "node:test";

import { createLayout } from "../features/meeting/client/layout.mjs";
import { createMeetingParticipants, roomFromState } from "../features/meeting/client/participants.mjs";

const stamp = (sessionId) => ({ roomInstanceId: "r", sessionId, admissionEpoch: 1 });

/** Fake client state with two humans and one muted microphone. */
function baseState() {
  return {
    status: "admitted",
    selfId: "me",
    presenter: true,
    speakerId: "",
    participants: {
      me: { id: "me", stamp: stamp("me"), name: "Me", avatar: "", presenter: true, bot: false },
      bob: { id: "bob", stamp: stamp("bob"), name: "Bob", avatar: "", presenter: false, bot: false },
    },
    producers: { p1: { id: "p1", participantId: "bob", kind: "audio", paused: true, system: false } },
  };
}

/** Fake client recording commands and emitting events. */
function fakeClient() {
  let state = baseState();
  const listeners = new Set();
  const events = new Set();
  const commands = [];
  return {
    commands,
    getState: () => state,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    subscribeEvents: (listener) => (events.add(listener), () => events.delete(listener)),
    async command(action) {
      commands.push(action);
      return {};
    },
    emit: (kind, value) => events.forEach((listener) => listener(kind, value)),
    setState(next) {
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

/** Build the participants source over fakes. */
function setup() {
  const client = fakeClient();
  const layout = createLayout();
  const chatCalls = [];
  const chat = { setVisible: (value) => chatCalls.push(["visible", value]), selectConversation: (_fence, id) => chatCalls.push(["select", id]) };
  const clipboard = { text: "", writeText: async (value) => (clipboard.text = value) };
  const source = createMeetingParticipants({ client, layout, chat, slug: "room", origin: "https://x.test", clipboard });
  return { client, layout, chat, chatCalls, clipboard, source };
}

test("room projection carries names, roles and derived microphone state", () => {
  const peers = JSON.parse(roomFromState(baseState()).peers);
  assert.deepEqual(peers.map(([id, { peer_info }]) => [id, peer_info.peer_name, peer_info.peer_presenter, peer_info.peer_audio]), [
    ["me", "Me", true, false],
    ["bob", "Bob", false, false],
  ]);
});

test("snapshot follows client participants and capabilities", () => {
  const { source, client } = setup();
  assert.deepEqual(source.getSnapshot().peers.map((peer) => peer.name), ["Me", "Bob"]);
  assert.equal(source.getSnapshot().presenter, true);
  client.setState({ participants: { me: baseState().participants.me } });
  assert.deepEqual(source.getSnapshot().peers.map((peer) => peer.name), ["Me"]);
});

test("server commands map to Rust actions with current stamps", async () => {
  const { source, client } = setup();
  const cases = [
    [{ type: "role", targetId: "bob", presenter: true }, { type: "setRole", target: stamp("bob"), presenter: true }],
    [{ type: "moderate", targetId: "bob", action: "mute" }, { type: "peerModeration", targets: [stamp("bob")], action: "mute", message: null }],
    [{ type: "moderateAll", action: "hide" }, { type: "peerModeration", targets: [stamp("bob")], action: "hide", message: null }],
  ];
  for (const [command, expected] of cases) {
    await source.execute(command);
    assert.deepEqual(client.commands.at(-1), expected, command.type);
  }
  // "Everyone follows the presenter" was removed.
  await assert.rejects(source.execute({ type: "follow", enabled: true }));
  await assert.rejects(source.execute({ type: "role", targetId: "ghost", presenter: true }), /unavailable/);
});

test("local commands update layout, chat and clipboard without server calls", async () => {
  const { source, client, layout, chatCalls, clipboard } = setup();
  await source.execute({ type: "pin", targetId: "bob" });
  assert.equal(layout.getSnapshot().pinned, "bob");
  await source.execute({ type: "pin", targetId: "bob" });
  assert.equal(layout.getSnapshot().pinned, "", "pinning again unpins");
  await source.execute({ type: "visibility", targetId: "bob", hidden: true });
  await source.execute({ type: "volume", targetId: "bob", value: 40 });
  assert.deepEqual(layout.getSnapshot().hidden, ["bob"]);
  assert.equal(layout.gain("bob"), 0.4);
  await source.execute({ type: "chat", targetId: "bob" });
  assert.deepEqual(chatCalls, [["visible", true], ["select", "bob"]]);
  await source.execute({ type: "invite" });
  assert.equal(clipboard.text, "https://x.test/room/room");
  assert.equal(client.commands.length, 0);
});

test("lobby entrants come from relays and leave on accept or reject", async () => {
  const { source, client } = setup();
  client.emit("roomLobby", { lobby_status: "waiting", peer_id: "eve", peer_name: "Eve", peer_avatar: "", stamp: stamp("eve") });
  client.emit("roomLobby", { lobby_status: "waiting", peer_id: "joe", peer_name: "Joe", peer_avatar: "", stamp: stamp("joe") });
  assert.deepEqual(source.getSnapshot().lobby.map((entry) => entry.name), ["Eve", "Joe"]);
  await source.execute({ type: "lobby", targetId: "eve", accepted: true });
  assert.deepEqual(client.commands.at(-1), { type: "lobby", targets: [stamp("eve")], accepted: true });
  client.emit("roomLobby", { lobby_status: "accept", peer_id: "eve" });
  assert.deepEqual(source.getSnapshot().lobby.map((entry) => entry.name), ["Joe"]);
  client.emit("roomLobby", { lobby_status: "reject", peers_id: ["joe"] });
  assert.equal(source.getSnapshot().lobby.length, 0);
});

test("layout forgets participants that left", () => {
  const { layout, client } = setup();
  layout.pin("bob");
  layout.setHidden("bob", true);
  client.setState({ participants: { me: baseState().participants.me } });
  assert.deepEqual(layout.getSnapshot(), { pinned: "", hidden: [], volumes: {} });
});

test("dock visibility toggles locally and close hides it", async () => {
  const { source } = setup();
  source.toggle();
  assert.equal(source.getSnapshot().visible, true);
  await source.execute({ type: "close" });
  assert.equal(source.getSnapshot().visible, false);
});

test("invite opens the room share dialog when the room provides one", async () => {
  const client = fakeClient();
  const clipboard = { text: "", writeText: async (value) => (clipboard.text = value) };
  let shared = 0;
  const chat = { setVisible() {}, selectConversation() {} };
  const source = createMeetingParticipants({ client, layout: createLayout(), chat, slug: "room", origin: "https://x.test", clipboard, onShare: () => shared++ });
  await source.execute({ type: "invite" });
  assert.equal(shared, 1);
  assert.equal(clipboard.text, "", "no silent copy when the dialog opens");
});

test("a ban waits for the room confirmation; focus goes through the layout transition", async () => {
  for (const [name, answer, sent] of [["confirmed ban is sent", true, 1], ["declined ban is not sent", false, 0]]) {
    const client = fakeClient();
    const asked = [];
    const transitions = [];
    const layout = createLayout();
    const source = createMeetingParticipants({ client, layout, chat: { setVisible() {}, selectConversation() {} }, slug: "room", origin: "https://x.test",
      confirm: async (request) => { asked.push(request); return answer; }, layoutTransition: (change) => { transitions.push(1); change(); } });
    const before = client.commands.length;
    await source.execute({ type: "moderate", targetId: "bob", action: "ban" });
    assert.equal(asked[0]?.kind, "ban", name);
    assert.equal(client.commands.length - before, sent, name);
    await source.execute({ type: "pin", targetId: "bob" });
    assert.equal(transitions.length, 1, name);
    assert.equal(layout.getSnapshot().pinned, "bob", name);
  }
});

test("grid visibility follows card actions, panel actions and dock reopening", async () => {
  const { source, layout } = setup();
  const cases = [
    ["card hides", () => layout.setHidden("bob", true), ["bob"]],
    ["dock reopens", () => { source.toggle(); source.toggle(); }, ["bob"]],
    ["panel shows", () => source.execute({ type: "visibility", targetId: "bob", hidden: false }), []],
    ["panel hides", () => source.execute({ type: "visibility", targetId: "bob", hidden: true }), ["bob"]],
    ["layout shows", () => layout.setHidden("bob", false), []],
  ];
  for (const [name, change, expected] of cases) {
    await change();
    assert.deepEqual(source.getSnapshot().hidden, expected, name);
    assert.equal(source.getSnapshot().hidden, layout.getSnapshot().hidden, name);
  }
});

test("visibility clears departed peers and stops observing after disposal", () => {
  const { source, layout, client } = setup();
  layout.setHidden("bob", true);
  client.setState({ participants: { me: baseState().participants.me } });
  assert.deepEqual(source.getSnapshot().hidden, []);
  source.dispose();
  const snapshot = source.getSnapshot();
  layout.setHidden("me", true);
  assert.equal(source.getSnapshot(), snapshot);
});

test("music volume snapshot follows local playback and persists between visits", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const client = fakeClient();
  const layout = createLayout({ storage, slug: "room" });
  const source = createMeetingParticipants({ client, layout, chat: {}, slug: "room" });
  await source.execute({ type: "volume", targetId: "bodrik-music", value: 35 });
  assert.equal(source.getSnapshot().volumes["bodrik-music"], 35);
  assert.equal(layout.gain("bodrik-music"), 0.35);
  layout.setVolume("bodrik-music", 60);
  assert.equal(source.getSnapshot().volumes["bodrik-music"], 60);
  source.dispose();
  const restored = createLayout({ storage, slug: "room" });
  restored.retain(["bodrik-music"]);
  assert.equal(restored.gain("bodrik-music"), 0.6);
});
