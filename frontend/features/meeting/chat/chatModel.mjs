import { CHAT_FILE_BYTES } from "./chatAttachment.mjs";
import { decodeChatMessage, decodeChatSession, decodeChatSubmission } from "./chatEvents.mjs";

/** Create an observation-only chat source: no socket, timers, sends, delivery ACKs or persistence. */
export function createChatSource({ historyLimit = 200, now = () => Date.now() } = {}) {
  for (const [name, value, maximum] of [["historyLimit", historyLimit, 1000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`Invalid chat ${name}`);
  }
  if (typeof now !== "function") throw new TypeError("Invalid chat clock");
  let session = null;
  let fence = null;
  let messages = [];
  let recipients = [];
  let visible = false;
  let selected = "all";
  let disposed = false;
  let sequence = 0;
  const listeners = new Set();
  let snapshot = Object.freeze({ messages: Object.freeze([]), unread: 0, visible: false, selected: "all", conversations: Object.freeze([]) });

  /** Publish one immutable snapshot; unread derives from retained read flags, not a synchronized counter. */
  function publish() {
    const groups = new Map([["all", { id: "all", name: "", unread: 0, available: true }], ...recipients.map((item) => [item.id, { ...item, unread: 0, available: true }])]);
    for (const item of messages) {
      const id = conversation(item);
      if (!groups.has(id)) groups.set(id, { id, name: item.direction === "outgoing" ? item.targetName : item.name, unread: 0, available: false });
      if (!item.read) groups.get(id).unread++;
    }
    if (!groups.has(selected)) {
      selected = "all";
      markSelectedRead();
      for (const group of groups.values()) group.unread = 0;
      for (const item of messages) if (!item.read) groups.get(conversation(item)).unread++;
    }
    snapshot = Object.freeze({ messages: Object.freeze(messages.slice()), unread: messages.filter((item) => !item.read).length, visible, selected,
      conversations: Object.freeze([...groups.values()].map((item) => Object.freeze(item))) });
    for (const listener of listeners) listener();
  }

  /** Incoming private messages belong to the sender conversation, not the local recipient's identity. */
  function conversation(item) { return item.targetId === "all" ? "all" : item.direction === "outgoing" ? item.targetId : item.peerId; }

  /** Mark only the visible selected conversation read; other private/public unread flags remain unchanged. */
  function markSelectedRead() {
    if (visible) messages = messages.map((item) => item.read || conversation(item) !== selected ? item : Object.freeze({ ...item, read: true }));
  }

  /** Accept only the exact live session fence; stale/disposed callbacks cannot mutate this source. */
  function current(candidate) { return !disposed && session !== null && candidate === fence; }

  return {
    /** Read immutable UI data; private room identity and session fence are never included. */
    getSnapshot: () => snapshot,
    /** Observe state only; construction/subscription never attaches transport listeners or requests history. */
    subscribe(listener) {
      if (disposed) return () => {};
      if (typeof listener !== "function") throw new TypeError("Invalid chat observer");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Replace session atomically, clearing history/unread and invalidating old callbacks even for identical identities. */
    replaceSession(input) {
      if (disposed) throw new Error("Chat source disposed");
      const next = decodeChatSession(input);
      const nextFence = Object.freeze({});
      session = next;
      fence = nextFence;
      messages = [];
      recipients = [];
      visible = false;
      selected = "all";
      sequence = 0;
      publish();
      return nextFence;
    },
    /** Append an incoming relay, deduplicating only retained sender/message pairs; legacy messages may omit an ID. */
    receiveMessage(candidate, input) {
      if (!current(candidate)) return false;
      const event = decodeChatMessage(input, session);
      if (!event) return false;
      if (event.messageId !== null && messages.some((item) => item.peerId === event.peerId && item.messageId === event.messageId)) return false;
      const item = Object.freeze({ ...event, key: ++sequence, receivedAt: now(), read: visible && conversation(event) === selected });
      messages = [...messages, item].slice(-historyLimit);
      if (selected !== "all" && !recipients.some((entry) => entry.id === selected) && !messages.some((entry) => conversation(entry) === selected)) {
        selected = "all";
        markSelectedRead();
      }
      publish();
      return true;
    },
    /** Retain a transfer's conversation once; progress and verified bytes stay with the attachment source. */
    recordTransfer(candidate, value) {
      if (!current(candidate)) return false;
      if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > CHAT_FILE_BYTES) throw new TypeError("Invalid chat attachment size");
      const input = { room_id: session.roomId, peer_id: value.peerId, peer_name: value.peerName,
        to_peer_id: value.targetId, to_peer_name: value.targetName || "all", peer_msg: value.name, msg_id: `file:${value.messageId}` };
      const event = value.direction === "outgoing" ? decodeChatSubmission(input, session) : decodeChatMessage(input, session);
      if (!event || messages.some((item) => item.peerId === event.peerId && item.messageId === event.messageId)) return false;
      const item = Object.freeze({ ...event, attachmentId: value.messageId, attachmentSize: value.size, key: ++sequence, receivedAt: now(),
        read: event.direction === "outgoing" || (visible && conversation(event) === selected) });
      messages = [...messages, item].slice(-historyLimit);
      publish();
      return true;
    },
    /** Refresh display-only recipients from the admitted runtime registry; this list never authorizes a send. */
    setRecipients(candidate, input) {
      if (!current(candidate)) return false;
      if (!Array.isArray(input) || input.length > 1000) throw new TypeError("Invalid chat recipients");
      const seen = new Set();
      const next = input.map((item) => {
        if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 160 || item.id === "all" || seen.has(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 64) throw new TypeError("Invalid chat recipient");
        seen.add(item.id);
        return Object.freeze({ id: item.id, name: item.name });
      });
      recipients = next;
      publish();
      return true;
    },
    /** Record an actual local emit as an outgoing observation; never create a delivered/successful-server state. */
    recordSubmission(candidate, input) {
      if (!current(candidate)) return false;
      const event = decodeChatSubmission(input, session);
      if (messages.some((item) => item.peerId === event.peerId && item.messageId === event.messageId)) return false;
      messages = [...messages, Object.freeze({ ...event, key: ++sequence, receivedAt: now(), read: true })].slice(-historyLimit);
      publish();
      return true;
    },
    /** Merge canonical durable rows, preserving private messages and deriving unread only for live additions. */
    mergePublic(candidate, rows, removed = [], historical = false) {
      if (!current(candidate)) return false;
      const deleted = new Set(removed);
      const retained = messages.filter((item) => !item.durableId || !deleted.has(item.durableId));
      const known = new Set(retained.map((item) => item.durableId));
      for (const row of rows) {
        if (!row || typeof row.id !== "string" || !/^[1-9][0-9]*$/.test(row.id) || known.has(row.id) || deleted.has(row.id)) continue;
        known.add(row.id);
        const item = { key: `public:${row.id}`, durableId: row.id, messageId: row.id, peerId: row.own ? session.peerId : `history:${row.id}`,
          name: row.name, avatar: row.avatar, body: row.text, targetId: "all", targetName: "all", direction: row.own ? "outgoing" : "incoming",
          receivedAt: row.createdAt, read: historical || row.own || visible && selected === "all", canDelete: row.canDelete,
          attachment: row.attachment ? Object.freeze({ ...row.attachment, phase: "completed", downloadable: true, persistent: true }) : null };
        retained.push(Object.freeze(item));
      }
      messages = retained.sort((a,b) => a.receivedAt-b.receivedAt || (a.durableId && b.durableId ? (BigInt(a.durableId)<BigInt(b.durableId) ? -1 : 1) : 0)).slice(-historyLimit);
      publish();
      return true;
    },
    /** Delete local ephemeral history only, with no server message-deletion contract. */
    deleteMessage(candidate, key) {
      if (!current(candidate)) return false;
      const next = messages.filter((item) => item.key !== key);
      if (next.length === messages.length) return false;
      messages = next;
      publish();
      return true;
    },
    /** Select an existing observed conversation; selected peer IDs remain display routing, not authorization. */
    selectConversation(candidate, id) {
      if (!current(candidate)) return false;
      if (typeof id !== "string" || !snapshot.conversations.some((item) => item.id === id)) throw new TypeError("Invalid chat conversation");
      if (selected === id) return false;
      selected = id;
      markSelectedRead();
      publish();
      return true;
    },
    /** Set actual panel visibility explicitly; opening acknowledges only local unread state, not network delivery. */
    setVisible(candidate, value) {
      if (!current(candidate)) return false;
      if (typeof value !== "boolean") throw new TypeError("Invalid chat visibility");
      if (visible === value) return false;
      visible = value;
      markSelectedRead();
      publish();
      return true;
    },
    /** Fence obsolete work and release owned observers; no remote rollback, socket teardown or message deletion is implied. */
    dispose() {
      if (disposed) return;
      disposed = true;
      session = null;
      fence = null;
      messages = [];
      recipients = [];
      visible = false;
      selected = "all";
      listeners.clear();
      publish();
    },
  };
}
