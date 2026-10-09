import { createFilesSource } from "../files/filesModel.mjs";
import { createFileTransfers } from "./fileTransfer.mjs";

/** Verified received files kept for download. */
const MAX_RECEIVED = 24;

/**
 * Attachment source for chat, backed by the meeting client: sends and
 * receives file-transfer v1 over the meeting socket and keeps verified received
 * and original outgoing files in memory until the session ends or they are evicted.
 */
export function createMeetingFiles({ client, save }) {
  const received = new Map(); // transferId -> { name, mediaType, bytes }
  const state = () => client.getState();
  const nameOf = (id) => state().participants[id]?.name || "Participant";

  const transfers = createFileTransfers({
    command: (action) => client.command(action),
    sendBinary: (frame) => client.session.sendBinary(frame),
    complete(value) {
      received.set(value.transferId, { name: value.fileName, mediaType: value.mediaType || "application/octet-stream", bytes: value.bytes });
      while (received.size > MAX_RECEIVED) received.delete(received.keys().next().value);
    },
  });

  const source = createFilesSource({
    observe: (listener) => transfers.observe(listener),
    send(file, target, options) {
      const metadata = { ...options, peerId: state().selfId, targetId: target.type === "public" ? "all" : target.id };
      if (target.type === "public") return transfers.send(file, { type: "public" }, metadata);
      const stamp = state().participants[target.id]?.stamp;
      if (!stamp) return Promise.reject(new Error("File recipient unavailable"));
      return transfers.send(file, { type: "private", stamp }, { ...metadata, peerName: nameOf(target.id) });
    },
    cancel: (id) => transfers.cancel(id),
    download(id) {
      const file = received.get(id);
      if (!file) throw new Error("File unavailable");
      save(new Blob([file.bytes], { type: file.mediaType }), file.name);
    },
    getSession: () => state().selfId || null,
    getLanguage: () => state().language || "ru",
  });

  let status = state().status;
  let sessionId = state().selfId;
  const offState = client.subscribe(() => {
    const next = state().status;
    if (sessionId !== state().selfId) {
      sessionId = state().selfId;
      received.clear();
      transfers.clear();
    }
    if (next !== status && status === "admitted") transfers.reset("disconnected");
    status = next;
    source.refresh();
  });
  const offEvents = client.subscribeEvents((kind, value) => {
    if (kind.startsWith("file")) transfers.event(kind, value, { peerName: nameOf(value?.sender?.sessionId), peerId: value?.sender?.sessionId, targetId: value?.target?.type === "private" ? state().selfId : "all" }).catch(() => {});
  });
  const offBinary = client.subscribeBinary((data) => {
    try {
      transfers.binary(data);
    } catch {
      // A malformed or out-of-order frame fails only its transfer.
    }
  });

  return {
    ...source,
    /** Download availability is independent of retained transfer metadata. */
    hasDownload: (id) => received.has(id),
    /** Stop observing and drop buffers. */
    dispose() {
      offState();
      offEvents();
      offBinary();
      source.dispose();
      transfers.dispose();
      received.clear();
    },
  };
}
