/** File-transfer v1 wire constants (docs/meeting-backend/file-transfer-v1.md). */
const VERSION = 1;
const HEADER_BYTES = 27;
export const CHUNK_BYTES = 16 * 1024;
const MAX_VISIBLE_TRANSFERS = 24;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Convert a canonical UUID string into its 16 wire bytes. */
function uuidBytes(value) {
  const compact = String(value).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new Error("invalid transfer id");
  return Uint8Array.from(compact.match(/../g), (part) => Number.parseInt(part, 16));
}

/** Convert raw UUID bytes into canonical lowercase text. */
function uuidText(bytes) {
  const compact = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

/** Encode one version-1 binary frame. */
export function encodeFrame(transferId, sequence, finalChunk, payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength < 1 || payload.byteLength > CHUNK_BYTES) throw new Error("invalid chunk");
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame.set([0x42, 0x46, 0x31, VERSION], 0);
  frame.set(uuidBytes(transferId), 4);
  new DataView(frame.buffer).setUint32(20, sequence, false);
  frame[24] = finalChunk ? 1 : 0;
  new DataView(frame.buffer).setUint16(25, payload.byteLength, false);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

/** Decode and validate one version-1 binary frame. */
export function decodeFrame(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES || bytes[0] !== 0x42 || bytes[1] !== 0x46 || bytes[2] !== 0x31 || bytes[3] !== VERSION || (bytes[24] & ~1) !== 0) {
    throw new Error("invalid frame");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint16(25, false);
  if (length < 1 || length > CHUNK_BYTES || bytes.byteLength !== HEADER_BYTES + length) throw new Error("invalid frame");
  return {
    transferId: uuidText(bytes.subarray(4, 20)),
    sequence: view.getUint32(20, false),
    finalChunk: bytes[24] === 1,
    payload: bytes.slice(HEADER_BYTES),
  };
}

/** Lowercase hex SHA-256 of a byte sequence. */
export async function sha256(bytes, digest = globalThis.crypto?.subtle?.digest?.bind(globalThis.crypto.subtle)) {
  if (!digest) throw new Error("SHA-256 unavailable");
  const value = new Uint8Array(await digest("SHA-256", bytes));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether a browser File/Blob is acceptable for transfer. */
function validFile(file) {
  return Boolean(file) && Number.isSafeInteger(file.size) && file.size >= 1 && file.size <= MAX_FILE_BYTES &&
    typeof file.name === "string" && file.name.length >= 1 && file.name.length <= 255 && !/[\\/:\u0000-\u001f\u007f]/.test(file.name) &&
    typeof (file.type || "") === "string" && (file.type || "").length <= 128;
}

/**
 * Own file transfers for one client: hash and stream outgoing files, buffer and
 * verify incoming ones. Observers get bounded metadata only; bytes never enter it.
 * `complete({ ...offer, bytes })` retains verified incoming and original outgoing files.
 */
export function createFileTransfers({ command, sendBinary, complete, digest }) {
  const outgoing = new Set();
  const incoming = new Map();
  const visible = new Map();
  const listeners = new Set();
  const preparing = new Map();
  let sequence = 0;
  let disposed = false;
  let generation = 0;

  /** Immutable metadata list. */
  function snapshot() {
    return Object.freeze(Array.from(visible.values(), (value) => Object.freeze({ ...value })));
  }

  /** Merge one change into a visible transfer and notify. */
  function publish(id, change) {
    visible.set(id, { ...(visible.get(id) || {}), ...change, id });
    while (visible.size > MAX_VISIBLE_TRANSFERS) visible.delete(visible.keys().next().value);
    const current = snapshot();
    for (const listener of [...listeners]) listener(current);
  }

  /** Re-key a local preparation under the server-issued transfer id. */
  function replace(localId, transferId, change) {
    const current = visible.get(localId) || {};
    visible.delete(localId);
    publish(transferId, { ...current, ...change, id: transferId });
  }

  const api = {
    /** Observe metadata; the listener is called immediately. */
    observe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },

    /** Hash, offer and stream one file; `target` is `{ type: "public" }` or `{ type: "private", stamp }`. */
    async send(file, target, { peerName = "", peerId = "", targetId = "all", signal } = {}) {
      if (disposed || !validFile(file)) throw new Error("invalid file");
      const currentGeneration = generation;
      const localId = `preparing-${++sequence}`;
      const controller = new AbortController();
      preparing.set(localId, controller);
      const aborted = () => controller.signal.aborted || signal?.aborted || disposed || currentGeneration !== generation;
      publish(localId, { direction: "outgoing", phase: "preparing", name: file.name, mediaType: file.type || "", size: file.size, transferred: 0, peerName, peerId, targetId, messageId: localId, public: target?.type === "public", downloadable: false, error: "" });
      let transferId = "";
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (aborted()) throw new DOMException("Aborted", "AbortError");
        const hash = await sha256(bytes, digest);
        if (aborted()) throw new DOMException("Aborted", "AbortError");
        const allocation = await command({ type: "fileOffer", offer: { version: VERSION, target, fileName: file.name, mediaType: file.type || "", size: file.size, sha256: hash } });
        transferId = allocation?.transferId;
        if (!transferId || allocation?.chunkBytes !== CHUNK_BYTES) throw new Error("invalid allocation");
        preparing.delete(localId);
        outgoing.add(transferId);
        replace(localId, transferId, { phase: "transferring" });
        let index = 0;
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
          if (aborted() || !outgoing.has(transferId)) throw new DOMException("Aborted", "AbortError");
          const payload = bytes.slice(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
          await sendBinary(encodeFrame(transferId, index, offset + payload.byteLength === bytes.byteLength, payload));
          index += 1;
          publish(transferId, { transferred: offset + payload.byteLength });
        }
        if (aborted()) throw new DOMException("Aborted", "AbortError");
        await complete({ transferId, fileName: file.name, mediaType: file.type || "", bytes });
        if (aborted()) throw new DOMException("Aborted", "AbortError");
        publish(transferId, { downloadable: true });
        return transferId;
      } catch (error) {
        if (currentGeneration !== generation || disposed) throw error;
        preparing.delete(localId);
        if (transferId) await api.cancel(transferId).catch(() => {});
        else publish(localId, { phase: error.name === "AbortError" ? "cancelled" : "failed", error: error.name === "AbortError" ? "" : "failed" });
        throw error;
      }
    },

    /** Cancel a preparation, an outgoing transfer or an incoming delivery. */
    async cancel(transferId) {
      const preparation = preparing.get(transferId);
      if (preparation) {
        preparing.delete(transferId);
        preparation.abort();
        publish(transferId, { phase: "cancelled" });
        return;
      }
      outgoing.delete(transferId);
      incoming.delete(transferId);
      publish(transferId, { phase: "cancelled" });
      if (!disposed) await command({ type: "fileCancel", cancel: { version: VERSION, transferId } });
    },

    /** Apply one file event; returns whether it was a file event. */
    async event(kind, value, { peerName = "", peerId = "", targetId = "all" } = {}) {
      if (disposed || !value?.transferId) return false;
      if (kind === "fileOffer") {
        incoming.set(value.transferId, { metadata: value, sequence: 0, size: 0, chunks: [] });
        publish(value.transferId, { direction: "incoming", phase: "transferring", name: value.fileName, mediaType: value.mediaType || "", size: value.size, transferred: 0, peerName, peerId, targetId, messageId: value.transferId, public: value.target?.type !== "private", downloadable: false, error: "" });
        return true;
      }
      if (kind === "fileFailed") {
        incoming.delete(value.transferId);
        publish(value.transferId, { phase: "failed", error: "failed" });
        return true;
      }
      if (kind === "fileTransferComplete" || kind === "fileTransferFailed") {
        outgoing.delete(value.transferId);
        publish(value.transferId, { phase: kind === "fileTransferComplete" ? "completed" : "failed", error: kind === "fileTransferFailed" ? "failed" : "" });
        return true;
      }
      if (kind !== "fileComplete") return false;
      const entry = incoming.get(value.transferId);
      if (!entry || entry.size !== entry.metadata.size) throw new Error("incomplete transfer");
      const bytes = new Uint8Array(entry.size);
      let offset = 0;
      for (const chunk of entry.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const hash = await sha256(bytes, digest);
      if (disposed || incoming.get(value.transferId) !== entry) return false;
      if (hash !== entry.metadata.sha256) {
        incoming.delete(value.transferId);
        publish(value.transferId, { phase: "failed", error: "integrity_failure" });
        throw new Error("integrity failure");
      }
      await complete({ ...entry.metadata, bytes });
      if (disposed || incoming.get(value.transferId) !== entry) return false;
      incoming.delete(value.transferId);
      publish(value.transferId, { phase: "completed", transferred: entry.size, downloadable: true });
      return true;
    },

    /** Buffer one relayed frame until its verified completion event. */
    binary(input) {
      if (disposed) return false;
      const frame = decodeFrame(input);
      const entry = incoming.get(frame.transferId);
      if (!entry) return false;
      const nextSize = entry.size + frame.payload.byteLength;
      if (frame.sequence !== entry.sequence || nextSize > entry.metadata.size || frame.finalChunk !== (nextSize === entry.metadata.size)) {
        incoming.delete(frame.transferId);
        publish(frame.transferId, { phase: "failed", error: "invalid_sequence" });
        throw new Error("invalid sequence");
      }
      entry.sequence += 1;
      entry.size = nextSize;
      entry.chunks.push(frame.payload);
      publish(frame.transferId, { transferred: nextSize });
      return true;
    },

    /** Fail active transfers (disconnect); later transfers may start again. */
    reset(reason = "disconnected") {
      generation++;
      const active = new Set([...preparing.keys(), ...outgoing, ...incoming.keys()]);
      for (const controller of preparing.values()) controller.abort();
      preparing.clear();
      outgoing.clear();
      incoming.clear();
      for (const id of active) publish(id, { phase: "failed", error: reason });
    },

    /** Clear metadata and buffers when admission changes, without disposing the reusable source. */
    clear() {
      api.reset();
      visible.clear();
      for (const listener of [...listeners]) listener(snapshot());
    },

    /** Drop partial buffers and observers. */
    dispose() {
      api.reset("disposed");
      disposed = true;
      visible.clear();
      listeners.clear();
    },
  };
  return api;
}
