/** Retained server relay budgets; markup is data, never trusted renderable HTML. */
export const CHAT_LIMITS = Object.freeze({ body: 4000, name: 64, id: 160 });

/** Require an event object without accepting arrays or retaining arbitrary fields. */
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid chat event object");
  return value;
}

/** Validate a bounded, nonempty string without rewriting identity or message content. */
function string(value, limit, field) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new TypeError(`Invalid chat ${field}`);
  return value;
}

/** Copy a session's scalar identities only; these stay outside public chat snapshots. */
export function decodeChatSession(value) {
  const input = record(value);
  return Object.freeze({ roomId: string(input.roomId, CHAT_LIMITS.id, "room identity"), peerId: string(input.peerId, CHAT_LIMITS.id, "local identity") });
}

/** Decode an incoming retained message for this room/recipient; unknown fields, avatars and resource handles are omitted. */
export function decodeChatMessage(value, session) {
  const input = record(value);
  const roomId = string(input.room_id, CHAT_LIMITS.id, "room identity");
  const targetId = string(input.to_peer_id, CHAT_LIMITS.id, "recipient identity");
  if (roomId !== session.roomId || (targetId !== "all" && targetId !== session.peerId)) return null;
  return Object.freeze({
    messageId: input.msg_id === undefined ? null : string(input.msg_id, CHAT_LIMITS.id, "message identity"),
    peerId: string(input.peer_id, CHAT_LIMITS.id, "sender identity"),
    name: string(input.peer_name, CHAT_LIMITS.name, "sender name"),
    targetId,
    body: string(input.peer_msg, CHAT_LIMITS.body, "message body"),
    format: "legacy-markup",
    direction: "incoming",
  });
}

/** Project a locally emitted message, never treating it as remotely delivered or authorized. */
export function decodeChatSubmission(value, session) {
  const input = record(value);
  if (input.room_id !== session.roomId || input.peer_id !== session.peerId) throw new TypeError("Invalid local chat identity");
  const targetId = string(input.to_peer_id, CHAT_LIMITS.id, "recipient identity");
  const targetName = string(input.to_peer_name, CHAT_LIMITS.name, "recipient name");
  const projected = decodeChatMessage({ ...input, to_peer_id: "all" }, session);
  return Object.freeze({ ...projected, targetId, targetName, direction: "outgoing" });
}
