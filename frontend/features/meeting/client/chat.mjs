import { createAttachmentReads } from "./attachmentReads.mjs";
import { downloadBlob } from "./downloadBlob.mjs";
import { CHAT_IMAGE_TYPES } from "../chat/chatAttachment.mjs";
import { createChatSource } from "../chat/chatModel.mjs";

/** Accepted chat image types and size bounds (server enforces the same). */
const IMAGE_TYPES = CHAT_IMAGE_TYPES;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Display name fallback for participants without a profile name. */
const UNKNOWN_NAME = "Participant";

/**
 * Chat source for the React chat panel, backed by the meeting client. Incoming Rust
 * relays feed the chat model; sends and image uploads go through the client. The
 * server does not echo a sender's own messages, so successful sends are recorded here.
 */
export function createMeetingChat({ client, slug, uploadImage, files, randomId = () => globalThis.crypto.randomUUID() }) {
  const reads = createAttachmentReads((id, options) => client.attachmentBlob(id, options));
  const model = createChatSource({ historyLimit: 1000 });
  const listeners = new Set();
  let fence = null;
  let sessionKey = 0;
  let selfId = "";
  let snapshot = null;
  let recipientsKey = "";
  let historyLoading = false;
  let historyError = false;
  let hasMore = false;
  let cursor = null;
  const tombstones = new Set();
  let historyEpoch = 0;
  let retry = null;
  const seenTransfers = new Set();

  /** Current client state. */
  const room = () => client.getState();

  /** Display name for one participant id. */
  function nameOf(id) {
    return room().participants[id]?.name || UNKNOWN_NAME;
  }

  /** Combine the model snapshot with session availability. */
  function publish() {
    const state = room();
    const admitted = state.status === "admitted";
    snapshot = Object.freeze({
      ...model.getSnapshot(),
      messages: Object.freeze(model.getSnapshot().messages.map((message) => {
        if (!message.attachmentId) return message;
        const attachment = files?.getSnapshot().transfers.find((value) => value.messageId === message.attachmentId);
        return Object.freeze({ ...message, attachment: attachment ? Object.freeze({ ...attachment, downloadable: attachment.downloadable && (files.hasDownload?.(attachment.id) ?? true) }) :
          Object.freeze({ name: message.body, size: message.attachmentSize, phase: "unavailable", downloadable: false }) });
      })),
      historyLoading, historyError, hasMore,
      available: Boolean(fence) && admitted,
      canSend: Boolean(fence) && admitted,
      // The presenter may remove anyone's message; others only their own.
      canModerate: state.presenter === true,
      language: state.language || "ru",
      sessionKey,
    });
    for (const listener of [...listeners]) listener();
  }

  /** Start a new chat session whenever the client admits as a new session id. */
  function syncSession() {
    const state = room();
    if (state.selfId && state.selfId !== selfId) {
      selfId = state.selfId;
      fence = model.replaceSession({ roomId: slug, peerId: selfId });
      sessionKey += 1;
      recipientsKey = "";
      seenTransfers.clear();
      tombstones.clear();
      cursor = null; hasMore = false; historyLoading = false; retry = null;
      void loadHistory(true);
    }
    if (fence) {
      const recipients = Object.values(state.participants)
        .filter((value) => !value.bot && value.id !== selfId)
        .map((value) => ({ id: value.id, name: (value.name || UNKNOWN_NAME).slice(0, 64) }));
      const key = JSON.stringify(recipients);
      if (key !== recipientsKey) {
        recipientsKey = key;
        model.setRecipients(fence, recipients);
      }
    }
    publish();
  }

  /** Apply canonical mutations and remember removals so an older in-flight page cannot resurrect rows. */
  function mutation(value, historical = false) {
    for (const id of value.removed || []) tombstones.add(id);
    while (tombstones.size > 10000) { tombstones.delete(tombstones.values().next().value); historyEpoch++; }
    model.mergePublic(fence, value.message ? [value.message] : value.messages || [], [...tombstones], historical);
  }

  /** Fetch a bounded page and discard results from a retired session. */
  async function loadHistory(initial = false) {
    if (!fence || historyLoading || !initial && !hasMore) return;
    const current = fence;
    const epoch = historyEpoch;
    historyLoading = true; historyError = false; publish();
    try {
      const value = await client.command({ type: "chatHistory", before: initial ? null : cursor });
      if (fence !== current) return;
      if (!Array.isArray(value.messages) || typeof value.hasMore !== "boolean" || !Number.isSafeInteger(value.revision)) throw new Error("Invalid history response");
      if (epoch !== historyEpoch) throw new Error("History changed during loading");
      mutation(value, true);
      hasMore = value.hasMore === true;
      cursor = value.messages?.[0]?.id || cursor;
    } catch {
      if (fence === current) historyError = true;
    } finally {
      if (fence === current) { historyLoading = false; publish(); }
    }
  }

  /** Append each transfer once; updates only refresh its projected progress/download state. */
  function syncFiles() {
    if (!fence || !files) return;
    const values = files.getSnapshot().transfers;
    const retained = new Set(values.map((value) => value.messageId));
    for (const id of seenTransfers) if (!retained.has(id)) seenTransfers.delete(id);
    for (const value of values) {
      if (!value.peerId || seenTransfers.has(value.messageId)) continue;
      seenTransfers.add(value.messageId);
      model.recordTransfer(fence, { ...value, peerName: nameOf(value.peerId).slice(0, 64), targetName: value.public ? "all" : nameOf(value.targetId).slice(0, 64) });
    }
    publish();
  }

  /** Map one Rust relay into the model. */
  function receive(kind, value) {
    if (!fence) return;
    if (kind === "chatMutation") { mutation(value); return; }
    const sender = value?.sender?.sessionId;
    if (typeof sender !== "string") return;
    if (kind === "chatMessage") {
      model.receiveMessage(fence, {
        room_id: slug,
        peer_id: sender,
        peer_name: nameOf(sender),
        to_peer_id: value.target == null ? "all" : selfId,
        peer_msg: value.text,
        msg_id: value.messageId,
      });
    }
  }

  /** Message by local key in the current session, or throw. */
  function message(key, expectedSession) {
    if (expectedSession !== sessionKey) throw new Error("Chat session changed");
    const found = model.getSnapshot().messages.find((item) => item.key === key);
    if (!found) throw new Error("Chat message not found");
    return found;
  }

  model.subscribe(publish);
  const offState = client.subscribe(syncSession);
  const offEvents = client.subscribeEvents((kind, value) => {
    if (["chatMessage", "chatMutation"].includes(kind)) receive(kind, value);
  });
  syncSession();
  const offFiles = files?.subscribe(syncFiles);
  syncFiles();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Send the workspace draft `{ body, targetId }` (optionally with an image or document). */
    async submit(draft, { file, signal } = {}) {
      const text = typeof draft?.body === "string" ? draft.body.trim() : "";
      if (!text && !file) return { status: "empty", clearDraft: false };
      if (!fence) return { status: "rejected", clearDraft: false };
      const currentFence = fence;
      const selected = typeof draft?.targetId === "string" ? draft.targetId : model.getSnapshot().selected;
      const target = selected === "all" ? { type: "public" } : { type: "private", stamp: room().participants[selected]?.stamp };
      if (target.type === "private" && !target.stamp) return { status: "rejected", clearDraft: false };
      let fileSubmitted = false;
      try {
        let body = text;
        if (target.type === "public") {
          if (!retry || retry.text !== text || retry.file !== file) retry = { text, file, id: randomId(), attachment: null };
          if (file && !retry.attachment) retry.attachment = await client.uploadAttachment(file, { signal });
          if (signal?.aborted || fence !== currentFence) return { status: "rejected", clearDraft: false };
          const value = await client.command({ type: "chat", target, messageId: retry.id, text, attachmentId: retry.attachment?.id || null });
          if (!value.message || !Array.isArray(value.removed) || !Number.isSafeInteger(value.revision)) throw new Error("Invalid message response");
          if (fence === currentFence) { mutation(value); retry = null; }
          return { status: "submitted", clearDraft: true };
        }
        if (file && !IMAGE_TYPES.includes(file.type)) {
          if (!files) return { status: "rejected", clearDraft: false };
          await files.send(file, selected === "all" ? { type: "public" } : { type: "private", id: selected }, { signal });
          fileSubmitted = true;
          if (signal?.aborted || fence !== currentFence) return { status: "rejected", clearDraft: false };
          if (!text) return { status: "submitted", clearDraft: true };
        }
        if (file && IMAGE_TYPES.includes(file.type)) {
          if (file.size > IMAGE_MAX_BYTES) return { status: "rejected", clearDraft: false };
          const url = await uploadImage(file, { signal });
          if (signal?.aborted || fence !== currentFence) return { status: "rejected", clearDraft: false };
          body = text ? `${url}\n${text}` : url;
        }
        const messageId = randomId();
        await client.command({ type: "chat", target, messageId, text: body });
        if (fence === currentFence) {
          model.recordSubmission(currentFence, {
            room_id: slug,
            peer_id: selfId,
            peer_name: nameOf(selfId),
            to_peer_id: selected,
            to_peer_name: selected === "all" ? "all" : nameOf(selected),
            peer_msg: body,
            msg_id: messageId,
          });
        }
        return { status: "submitted", clearDraft: true };
      } catch {
        return fileSubmitted ? { status: "rejected", reason: "caption", clearDraft: false, clearAttachment: true } : { status: "rejected", clearDraft: false };
      }
    },
    /** Download verified attachment bytes without rendering arbitrary file content. */
    async download(id) {
      const attachment = snapshot.messages.find((item) => item.attachment?.id === id)?.attachment;
      if (!attachment?.persistent) return files?.download(id);
      const blob = await reads.read(id);
      downloadBlob(blob, attachment.name);
    },
    /** Fetch authorized image bytes; the React owner releases its object URL. */
    attachmentBlob: (id, options) => reads.read(id, options),
    /** Load older history or retry a failed initial request. */
    loadOlder: () => loadHistory(cursor === null),
    /** Cancel only the selected attachment transfer. */
    cancelTransfer: (id) => files?.cancel(id),
    /** Delete durable public messages globally; private messages are removed locally. */
    async remove(key, expectedSession) {
      const found = message(key, expectedSession);
      if (!found.durableId) { model.deleteMessage(fence, key); return; }
      const current = fence;
      const result = await client.command({ type: "chatDelete", messageId: found.durableId });
      if (!Array.isArray(result.removed) || !Number.isSafeInteger(result.revision)) throw new Error("Invalid deletion response");
      if (current === fence) mutation(result);
    },
    /** Switch conversation; the workspace passes its own (unused) fence first. */
    selectConversation: (_viewFence, id) => model.selectConversation(fence, id),
    /** Show or hide the panel (marks the visible conversation read). */
    setVisible: (visible) => fence && model.setVisible(fence, visible),
    /** Toggle panel visibility. */
    toggle: () => fence && model.setVisible(fence, !model.getSnapshot().visible),
    /** Avatar path for a participant. */
    getAvatar: (peerId) => room().participants[peerId]?.avatar || "",
    /** Close the panel. */
    close: () => fence && model.setVisible(fence, false),
    /** Stop observing the client. */
    dispose() {
      offState();
      offEvents();
      offFiles?.();
      fence = null; retry = null; tombstones.clear();
      reads.dispose();
      seenTransfers.clear();
      model.dispose();
      listeners.clear();
    },
  };
}
