import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_LIMITS, decodeChatMessage } from "../features/meeting/chat/chatEvents.mjs";
import { createChatSource } from "../features/meeting/chat/chatModel.mjs";

const session = Object.freeze({ roomId: "fixture-room", peerId: "local-peer" });
/** Construct a retained server message using synthetic identities only. */
function message(extra = {}) {
  return { room_id: session.roomId, peer_id: "remote-peer", peer_name: "Remote", to_peer_id: "all", peer_msg: "hello", msg_id: "m1", ...extra };
}
/** Bind a new source without any transport or browser dependencies. */
function fixture(options) {
  const source = createChatSource(options);
  return { source, fence: source.replaceSession(session) };
}

for (const [name, field, limit] of [["body", "peer_msg", CHAT_LIMITS.body], ["name", "peer_name", CHAT_LIMITS.name], ["sender", "peer_id", CHAT_LIMITS.id], ["message ID", "msg_id", CHAT_LIMITS.id]]) {
  test(`chat ${name} accepts exact budget and rejects oversized/empty/nonstring values`, () => {
    assert.ok(decodeChatMessage(message({ [field]: "x".repeat(limit) }), session));
    for (const value of ["x".repeat(limit + 1), " ", null, 42]) assert.throws(() => decodeChatMessage(message({ [field]: value }), session), /Invalid chat/);
  });
}
for (const [name, patch] of [["other room", { room_id: "other-room" }], ["other private recipient", { to_peer_id: "other-peer" }]]) {
  test(`chat ignores ${name} instead of adding unread content`, () => {
    const h = fixture();
    assert.equal(h.source.receiveMessage(h.fence, message(patch)), false);
    assert.equal(h.source.getSnapshot().unread, 0);
  });
}
test("chat retains public/direct messages as immutable markup data, never arbitrary fields or resource handles", () => {
  const h = fixture();
  const input = message({ peer_msg: '<img src=x onerror="bad()">', to_peer_id: session.peerId, peer_token: "synthetic-proof", socket: {}, peer_avatar: "https://foreign.invalid/avatar", peer_uuid: "private-uuid" });
  h.source.receiveMessage(h.fence, input);
  input.peer_msg = "mutated";
  const snapshot = h.source.getSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ["conversations", "messages", "selected", "unread", "visible"]);
  const item = snapshot.messages[0];
  assert.equal(item.body, '<img src=x onerror="bad()">');
  assert.equal(item.format, "legacy-markup");
  assert.equal(JSON.stringify(snapshot).includes("synthetic-proof"), false);
  assert.equal(JSON.stringify(snapshot).includes("private-uuid"), false);
  assert.equal(JSON.stringify(snapshot).includes("fixture-room"), false);
  for (const value of [snapshot, snapshot.messages, item]) assert.equal(Object.isFrozen(value), true);
});
test("legacy messages without IDs remain distinct; sender/message deduplication is bounded to retained history", () => {
  const h = fixture({ historyLimit: 2 });
  h.source.receiveMessage(h.fence, message());
  assert.equal(h.source.receiveMessage(h.fence, message()), false);
  h.source.receiveMessage(h.fence, message({ peer_id: "other-peer" }));
  assert.equal(h.source.getSnapshot().messages.length, 2);
  h.source.receiveMessage(h.fence, message({ msg_id: undefined }));
  h.source.receiveMessage(h.fence, message({ msg_id: undefined }));
  assert.deepEqual(h.source.getSnapshot().messages.map((item) => item.messageId), [null, null]);
  assert.equal(h.source.getSnapshot().unread, 2);
  assert.equal(h.source.receiveMessage(h.fence, message()), true);
});
test("unread derives from retained history and visibility; opening is not a delivery ACK", () => {
  const h = fixture();
  h.source.receiveMessage(h.fence, message());
  assert.equal(h.source.getSnapshot().unread, 1);
  h.source.setVisible(h.fence, true);
  h.source.receiveMessage(h.fence, message({ msg_id: "m2" }));
  assert.equal(h.source.getSnapshot().unread, 0);
  h.source.setVisible(h.fence, false);
  h.source.receiveMessage(h.fence, message({ msg_id: "m3" }));
  assert.equal(h.source.getSnapshot().unread, 1);
  assert.throws(() => h.source.setVisible(h.fence, "true"), /visibility/);
});
test("same-ID session replacement fences old message/visibility callbacks and clears unread", () => {
  const h = fixture();
  h.source.receiveMessage(h.fence, message());
  const next = h.source.replaceSession(session);
  assert.notEqual(next, h.fence);
  assert.equal(h.source.receiveMessage(h.fence, null), false);
  assert.equal(h.source.setVisible(h.fence, true), false);
  assert.equal(h.source.getSnapshot().unread, 0);
  assert.equal(h.source.receiveMessage(next, message()), true);
});
test("invalid session replacement does not invalidate valid state; disposal releases observers and rejects late work", () => {
  const h = fixture();
  let notifications = 0;
  const stop = h.source.subscribe(() => notifications++);
  assert.equal(notifications, 0);
  assert.throws(() => h.source.replaceSession({ ...session, peerId: "" }), /Invalid chat/);
  h.source.receiveMessage(h.fence, message());
  assert.equal(notifications, 1);
  stop(); stop();
  h.source.dispose(); h.source.dispose();
  assert.equal(h.source.getSnapshot().messages.length, 0);
  assert.equal(h.source.receiveMessage(h.fence, message()), false);
  assert.throws(() => h.source.replaceSession(session), /disposed/);
  h.source.subscribe(() => notifications++ )();
  assert.equal(notifications, 1);
});
test("reentrant session replacement never returns the newer session's fence to an older caller", () => {
  const source = createChatSource();
  let nestedFence;
  const stop = source.subscribe(() => { stop(); nestedFence = source.replaceSession({ ...session, roomId: "next-room" }); });
  const oldFence = source.replaceSession(session);
  assert.notEqual(oldFence, nestedFence);
  assert.equal(source.receiveMessage(oldFence, message()), false);
  assert.equal(source.receiveMessage(nestedFence, message({ room_id: "next-room" })), true);
});
test("conversation selection marks only visible public/private messages read and fences stale selection", () => {
  const h = fixture();
  h.source.receiveMessage(h.fence, message());
  h.source.receiveMessage(h.fence, message({ msg_id: "private", to_peer_id: session.peerId }));
  h.source.setVisible(h.fence, true);
  assert.equal(h.source.getSnapshot().unread, 1);
  assert.equal(h.source.getSnapshot().selected, "all");
  assert.equal(h.source.getSnapshot().conversations.find((item) => item.id === "remote-peer").unread, 1);
  h.source.selectConversation(h.fence, "remote-peer");
  assert.equal(h.source.getSnapshot().unread, 0);
  h.source.receiveMessage(h.fence, message({ msg_id: "new-public" }));
  assert.equal(h.source.getSnapshot().unread, 1);
  h.source.setVisible(h.fence, false);
  h.source.selectConversation(h.fence, "all");
  assert.equal(h.source.getSnapshot().unread, 1);
  assert.throws(() => h.source.selectConversation(h.fence, "unknown"), /conversation/);
  h.source.setVisible(h.fence, true);
  assert.equal(h.source.getSnapshot().unread, 0);
  h.source.replaceSession(session);
  assert.equal(h.source.selectConversation(h.fence, "remote-peer"), false);
});

test("history eviction reconciles a removed selected conversation to public chat", () => {
  const h = fixture({ historyLimit: 1 });
  h.source.receiveMessage(h.fence, message({ to_peer_id: session.peerId }));
  h.source.selectConversation(h.fence, "remote-peer");
  h.source.setVisible(h.fence, true);
  h.source.receiveMessage(h.fence, message({ msg_id: "public" }));
  assert.equal(h.source.getSnapshot().selected, "all");
  assert.equal(h.source.getSnapshot().unread, 0);
  assert.deepEqual(h.source.getSnapshot().conversations.map((item) => item.id), ["all"]);
});

for (const targetId of ["all", "remote-peer"]) {
  test(`local submission records outgoing ${targetId} without unread or delivered claims`, () => {
    const h = fixture();
    h.source.setRecipients(h.fence, [{ id: "remote-peer", name: "Remote", peer_token: "synthetic-private-proof" }]);
    const input = message({ peer_id: session.peerId, peer_name: "Local", to_peer_id: targetId, to_peer_name: "Remote" });
    assert.equal(h.source.recordSubmission(h.fence, input), true);
    assert.equal(h.source.recordSubmission(h.fence, input), false);
    const snapshot = h.source.getSnapshot();
    assert.equal(snapshot.unread, 0);
    assert.equal(snapshot.messages[0].direction, "outgoing");
    assert.equal(snapshot.messages[0].targetId, targetId);
    assert.equal(typeof snapshot.messages[0].receivedAt, "number");
    assert.equal(JSON.stringify(snapshot).includes("synthetic-private-proof"), false);
    assert.equal(JSON.stringify(snapshot).includes("delivered"), false);
    h.source.selectConversation(h.fence, targetId);
    h.source.deleteMessage(h.fence, snapshot.messages[0].key);
    assert.equal(h.source.getSnapshot().messages.length, 0);
  });
}
test("recipients are display projections, invalid replacement is atomic, and old-session commands are fenced", () => {
  const h = fixture();
  h.source.setRecipients(h.fence, [{ id: "remote-peer", name: "Remote" }]);
  assert.equal(h.source.getSnapshot().conversations[1].available, true);
  assert.throws(() => h.source.setRecipients(h.fence, [{ id: "duplicate", name: "A" }, { id: "duplicate", name: "B" }]), /recipient/);
  assert.equal(h.source.getSnapshot().conversations[1].id, "remote-peer");
  assert.throws(() => h.source.recordSubmission(h.fence, message({ to_peer_name: "Remote" })), /local chat identity/);
  h.source.receiveMessage(h.fence, message({ to_peer_id: session.peerId }));
  h.source.setRecipients(h.fence, []);
  assert.equal(h.source.getSnapshot().conversations[1].available, false);
  h.source.replaceSession(session);
  assert.equal(h.source.recordSubmission(h.fence, null), false);
  assert.equal(h.source.deleteMessage(h.fence, 1), false);
});

test("invalid observers and malformed event objects fail without mutating a live snapshot", () => {
  const h = fixture();
  assert.throws(() => h.source.subscribe(null), /observer/);
  for (const value of [null, [], "message"]) assert.throws(() => h.source.receiveMessage(h.fence, value), /object/);
  assert.equal(h.source.getSnapshot().messages.length, 0);
});

for (const [name, options] of [["zero history", { historyLimit: 0 }], ["excessive history", { historyLimit: 1001 }]]) {
  test(`chat source rejects ${name}`, () => assert.throws(() => createChatSource(options), /Invalid chat/));
}
