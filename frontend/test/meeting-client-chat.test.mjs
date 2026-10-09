import assert from "node:assert/strict";
import { test } from "node:test";

import { createMeetingChat } from "../features/meeting/client/chat.mjs";

const stamp = (sessionId) => ({ roomInstanceId: "r", sessionId, admissionEpoch: 1 });

/** Fake meeting client with settable state, emitted events and recorded commands. */
function fakeClient() {
  let state = {
    status: "admitted",
    selfId: "me",
    participants: {
      me: { id: "me", stamp: stamp("me"), name: "Me", avatar: "", bot: false },
      bob: { id: "bob", stamp: stamp("bob"), name: "Bob", avatar: "/uploads/avatars/x.png", bot: false },
      music: { id: "bodrik-music", name: "Бодрик FM", bot: true },
    },
  };
  const listeners = new Set();
  const eventListeners = new Set();
  const commands = [];
  let fail = false;
  let sequence = 0;
  const attachments = new Map();
  return {
    commands,
    getState: () => state,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    subscribeEvents: (listener) => (eventListeners.add(listener), () => eventListeners.delete(listener)),
    async command(action) {
      commands.push(action);
      if (fail) throw Object.assign(new Error("denied"), { code: "denied" });
      if (action.type === "chatHistory") return { messages: [], revision: 0, hasMore: false };
      if (action.type === "chat" && action.target.type === "public") return { message: { id: String(++sequence), name: "Me", avatar: "", text: action.text,
        createdAt: Date.now(), own: true, canDelete: true, attachment: attachments.get(action.attachmentId) || null }, removed: [], revision: sequence };
      return {};
    },
    async uploadAttachment(file) {
      if (file.type === "image/png" && file.size > 5 * 1024 * 1024) throw new Error("invalid");
      const value = { id: "attachment", name: file.name, size: file.size, kind: file.type === "image/png" ? "image" : "document" };
      attachments.set(value.id, value); return value;
    },
    emit: (kind, value) => eventListeners.forEach((listener) => listener(kind, value)),
    setState(next) {
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
    failNext: () => (fail = true),
  };
}

/** Build a chat over a fake client. */
function setup(files) {
  const client = fakeClient();
  let id = 0;
  const chat = createMeetingChat({
    client,
    slug: "room",
    files,
    uploadImage: async () => "https://x.test/uploads/chat/abc.png",
    randomId: () => `m${++id}`,
  });
  return { chat, client };
}

const bodies = (chat) => chat.getSnapshot().messages.map((item) => `${item.direction}:${item.targetId}:${item.body}`);

test("recipients exclude self and bots", () => {
  const { chat } = setup();
  assert.deepEqual(chat.getSnapshot().conversations.map((item) => item.id), ["all", "bob"]);
  assert.equal(chat.getSnapshot().available, true);
});

test("submit sends public and private messages and records them locally", async () => {
  const { chat, client } = setup();
  const cases = [
    ["public", { body: " hi ", targetId: "all" }, { type: "public" }, "outgoing:all:hi"],
    ["private", { body: "psst", targetId: "bob" }, { type: "private", stamp: stamp("bob") }, "outgoing:bob:psst"],
  ];
  for (const [name, draft, target, recorded] of cases) {
    const result = await chat.submit(draft);
    assert.deepEqual(result, { status: "submitted", clearDraft: true }, name);
    assert.deepEqual(client.commands.at(-1).target, target, name);
    assert.ok(bodies(chat).includes(recorded), name);
  }
});

test("submit outcomes for empty, unknown recipient, oversized image and rejection", async () => {
  const { chat, client } = setup();
  assert.equal((await chat.submit({ body: "  ", targetId: "all" })).status, "empty");
  assert.equal((await chat.submit({ body: "x", targetId: "ghost" })).status, "rejected");
  assert.equal((await chat.submit({ body: "x", targetId: "all" }, { file: { type: "image/png", size: 5 * 1024 * 1024 + 1 } })).status, "rejected");
  client.failNext();
  assert.deepEqual(await chat.submit({ body: "x", targetId: "all" }), { status: "rejected", clearDraft: false });
  assert.equal(chat.getSnapshot().messages.length, 0, "failed sends are not recorded");
});

test("public images use durable attachment metadata and retain their caption", async () => {
  const { chat, client } = setup();
  await chat.submit({ body: "look", targetId: "all" }, { file: { type: "image/png", size: 100 } });
  assert.equal(client.commands.at(-1).text, "look");
});

test("incoming relays map to public and private conversations", () => {
  const { chat, client } = setup();
  client.emit("chatMessage", { sender: stamp("bob"), target: null, messageId: "a", text: "to all" });
  client.emit("chatMessage", { sender: stamp("bob"), target: stamp("me"), messageId: "b", text: "to me" });
  client.emit("chatMessage", { sender: { sessionId: 5 }, target: null, messageId: "c", text: "bad" });
  assert.deepEqual(bodies(chat), ["incoming:all:to all", "incoming:me:to me"]);
  const unread = Object.fromEntries(chat.getSnapshot().conversations.map((item) => [item.id, item.unread]));
  assert.deepEqual(unread, { all: 1, bob: 1 });
});

test("a new session id clears history; the panel toggles and closes", async () => {
  const { chat, client } = setup();
  client.emit("chatMessage", { sender: stamp("bob"), target: null, messageId: "a", text: "hi" });
  chat.toggle();
  assert.equal(chat.getSnapshot().visible, true);
  chat.close();
  assert.equal(chat.getSnapshot().visible, false);
  chat.toggle();
  assert.equal(chat.getSnapshot().visible, true);
  client.setState({ selfId: "me2", participants: { ...client.getState().participants, me2: { id: "me2", stamp: stamp("me2"), name: "Me" } } });
  assert.equal(chat.getSnapshot().messages.length, 0);
  assert.equal(chat.getSnapshot().sessionKey, 2);
});

/** Observable attachment metadata without exposing file bytes to chat snapshots. */
function fakeFiles() {
  let values = [];
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    getSnapshot: () => ({ transfers: values }),
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    publish(next) { values = next; listeners.forEach((listener) => listener()); },
    async send(file, target, options) { sent.push({ file, target, options }); return "allocated"; },
    hasDownload: () => true,
    download: () => {},
  };
}

for (const [name, direction, targetId, selected] of [
  ["public incoming", "incoming", "all", "all"],
  ["private incoming", "incoming", "me", "bob"],
  ["private outgoing", "outgoing", "bob", "bob"],
]) test(`attachment conversation: ${name}`, () => {
  const files = fakeFiles();
  const { chat } = setup(files);
  const transfer = { id: "allocation", messageId: "stable", peerId: direction === "incoming" ? "bob" : "me", targetId,
    public: targetId === "all", direction, name: "rules.pdf", size: 1024, transferred: 0, phase: "transferring", downloadable: false };
  files.publish([transfer]);
  const first = chat.getSnapshot();
  assert.equal(first.messages.length, 1);
  assert.equal(first.conversations.find((value) => value.id === selected).unread, direction === "incoming" ? 1 : 0);
  files.publish([{ ...transfer, id: "rekeyed", phase: "completed", transferred: 1024, downloadable: true }]);
  assert.equal(chat.getSnapshot().messages.length, 1, "progress and allocation do not create duplicate messages");
  assert.equal(chat.getSnapshot().messages[0].attachment.id, "rekeyed");
  chat.selectConversation(null, selected);
  chat.setVisible(true);
  assert.equal(chat.getSnapshot().unread, 0);
  const message = chat.getSnapshot().messages[0];
  chat.remove(message.key, first.sessionKey);
  files.publish([{ ...transfer, transferred: 1024 }]);
  assert.equal(chat.getSnapshot().messages.length, 0, "progress does not resurrect locally deleted messages");
  chat.dispose();
});

for (const selected of ["all", "bob"]) test(`document submission uses the selected ${selected} conversation`, async () => {
  const files = fakeFiles();
  const { chat, client } = setup(files);
  const file = new File(["document"], "rules.pdf", { type: "application/pdf" });
  assert.deepEqual(await chat.submit({ body: "", targetId: selected }, { file }), { status: "submitted", clearDraft: true });
  if (selected === "all") {
    assert.equal(files.sent.length, 0);
    assert.equal(client.commands.at(-1).attachmentId, "attachment");
    assert.equal(chat.getSnapshot().messages[0].attachment.name, "rules.pdf");
  } else {
    assert.deepEqual(files.sent[0].target, { type: "private", id: "bob" });
    assert.equal(client.commands.filter((item) => item.type === "chat").length, 0);
  }
  chat.dispose();
});

test("a failed caption retains text but clears the already submitted file to prevent duplicate transfers", async () => {
  const files = fakeFiles();
  const { chat, client } = setup(files);
  client.failNext();
  const result = await chat.submit({ body: "caption", targetId: "bob" }, { file: new File(["doc"], "rules.pdf") });
  assert.deepEqual(result, { status: "rejected", reason: "caption", clearDraft: false, clearAttachment: true });
  assert.equal(files.sent.length, 1);
  chat.dispose();
});

test("evicted attachment metadata retains its filename and size but disables download", () => {
  const files = fakeFiles();
  const { chat } = setup(files);
  files.publish([{ id: "allocation", messageId: "stable", peerId: "bob", targetId: "all", public: true,
    direction: "incoming", name: "rules.pdf", size: 1024, transferred: 1024, phase: "completed", downloadable: true }]);
  files.publish([]);
  assert.deepEqual(chat.getSnapshot().messages[0].attachment, { name: "rules.pdf", size: 1024, phase: "unavailable", downloadable: false });
  chat.dispose();
});

/** Resolve an explicit in-flight history request for race and reconnect checks. */
function deferredHistoryClient() {
  const client = fakeClient();
  const pending = [];
  const original = client.command;
  client.command = (action) => action.type === "chatHistory" ? new Promise((resolve) => pending.push(resolve)) : original(action);
  return { client, pending };
}

/** Canonical durable row without exposing the verified actor. */
function durableRow(id, own = false) {
  return { id, name: "Saved", avatar: "", text: `saved ${id}`, createdAt: Number(id), own, canDelete: own, attachment: null };
}

test("history races: live duplicates merge once and deletes cannot be resurrected by an older page", async () => {
  const { client, pending } = deferredHistoryClient();
  const chat = createMeetingChat({ client, slug: "room" });
  client.emit("chatMutation", { message: durableRow("2"), removed: [], revision: 2 });
  client.emit("chatMutation", { message: null, removed: ["1"], revision: 3 });
  pending.shift()({ messages: [durableRow("1"), durableRow("2")], revision: 2, hasMore: true });
  await Promise.resolve();
  assert.deepEqual(chat.getSnapshot().messages.map((row) => row.durableId), ["2"]);
  assert.equal(chat.getSnapshot().unread, 1, "only the live row is unread");
  const older = chat.loadOlder();
  pending.shift()({ messages: [durableRow("1")], revision: 3, hasMore: false });
  await older;
  assert.deepEqual(chat.getSnapshot().messages.map((row) => row.durableId), ["2"]);
  chat.dispose();
});

test("reconnect discards obsolete pages and loads retained public history as read", async () => {
  const { client, pending } = deferredHistoryClient();
  const chat = createMeetingChat({ client, slug: "room" });
  client.setState({ selfId: "new-session" });
  pending.shift()({ messages: [durableRow("1")], revision: 1, hasMore: false });
  pending.shift()({ messages: [durableRow("2", true)], revision: 2, hasMore: false });
  await Promise.resolve();
  assert.deepEqual(chat.getSnapshot().messages.map((row) => row.durableId), ["2"]);
  assert.equal(chat.getSnapshot().messages[0].direction, "outgoing");
  assert.equal(chat.getSnapshot().unread, 0);
  chat.dispose();
});

test("failed durable send retains draft and reuses the uploaded attachment and retry identifier", async () => {
  const { chat, client } = setup();
  await Promise.resolve();
  const file = new File(["doc"], "rules.pdf");
  client.failNext();
  const first = await chat.submit({ body: "caption", targetId: "all" }, { file });
  const id = client.commands.at(-1).messageId;
  assert.deepEqual(first, { status: "rejected", clearDraft: false });
  assert.equal(chat.getSnapshot().messages.length, 0);
  const commands = client.commands.filter((action) => action.type === "chat");
  assert.equal(commands[0].attachmentId, "attachment");
  // Restore only the test transport failure; the draft/file instance remains unchanged.
  const send = client.command;
  client.command = async (action) => {
    if (action.type === "chat") { client.commands.push(action); return { message: durableRow("1", true), revision: 1, removed: [] }; }
    return send(action);
  };
  assert.equal((await chat.submit({ body: "caption", targetId: "all" }, { file })).status, "submitted");
  assert.equal(client.commands.at(-1).messageId, id);
  assert.equal(client.commands.at(-1).attachmentId, "attachment");
  chat.dispose();
});
