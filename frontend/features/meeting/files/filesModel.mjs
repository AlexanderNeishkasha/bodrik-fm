/** Maximum file size accepted by the version-1 replacement transfer contract. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Maximum transfer rows retained by the view source. */
const MAX_TRANSFERS = 24;

/** Normalize one adapter transfer without exposing files, bytes, stamps, or transport objects. */
function transfer(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id || value.id.length > 160)
    throw new Error("Invalid file transfer");
  if (!["outgoing", "incoming"].includes(value.direction) || !["preparing", "transferring", "completed", "failed", "cancelled"].includes(value.phase))
    throw new Error("Invalid file transfer state");
  if (typeof value.name !== "string" || !value.name || value.name.length > 255)
    throw new Error("Invalid file name");
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_FILE_BYTES)
    throw new Error("Invalid file size");
  if (!Number.isSafeInteger(value.transferred) || value.transferred < 0 || value.transferred > value.size)
    throw new Error("Invalid file progress");
  return Object.freeze({
    id: value.id,
    direction: value.direction,
    messageId: typeof value.messageId === "string" ? value.messageId.slice(0, 160) : value.id,
    peerId: typeof value.peerId === "string" ? value.peerId.slice(0, 160) : "",
    targetId: typeof value.targetId === "string" ? value.targetId.slice(0, 160) : "all",
    phase: value.phase,
    name: value.name,
    mediaType: typeof value.mediaType === "string" ? value.mediaType.slice(0, 128) : "",
    size: value.size,
    transferred: value.transferred,
    peerName: typeof value.peerName === "string" ? value.peerName.slice(0, 256) : "",
    public: value.public === true,
    error: typeof value.error === "string" ? value.error.slice(0, 80) : "",
    downloadable: value.downloadable === true,
  });
}

/** Own a bounded immutable projection while the replacement adapter retains transport and byte ownership. */
export function createFilesSource({ observe, send, cancel, download, getSession, getLanguage }) {
  if (typeof observe !== "function" || typeof send !== "function" || typeof cancel !== "function" || typeof download !== "function")
    throw new Error("Unsupported file transfer source");
  const listeners = new Set();
  let observedSession = getSession();
  let transfers = Object.freeze([]);
  let snapshot;
  let actionError = null;
  let disposed = false;

  /** Publish one immutable state and clear obsolete transfer metadata after readmission. */
  function refresh(values = transfers) {
    if (disposed) return;
    const session = getSession();
    if (session !== observedSession) {
      observedSession = session;
      values = [];
      actionError = null;
    }
    transfers = Object.freeze(Array.from(values).slice(-MAX_TRANSFERS).map(transfer));
    const next = Object.freeze({
      available: Boolean(session),
      language: getLanguage() === "en" ? "en" : "ru",
      transfers,
      actionError,
    });
    if (snapshot && next.available === snapshot.available && next.language === snapshot.language && next.transfers === snapshot.transfers && next.actionError === snapshot.actionError) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  const unsubscribe = observe((values) => refresh(values));
  refresh();

  /** Require current session ownership around one asynchronous transfer command. */
  async function execute(operation) {
    if (disposed || !getSession()) throw new Error("File transfer session unavailable");
    const session = getSession();
    actionError = null;
    refresh();
    try {
      const result = await operation();
      if (disposed || session !== getSession()) throw new DOMException("File transfer session changed", "AbortError");
      return result;
    } catch (failure) {
      if (!disposed && session === getSession() && failure.name !== "AbortError") actionError = "rejected";
      refresh();
      throw failure;
    }
  }

  return {
    getSnapshot: () => snapshot,
    /** Subscribe a view without opening a socket or retaining transfer payloads. */
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    /** Validate a selected browser file before delegating to the active replacement adapter. */
    send(file, target, options) {
      if (!file || typeof file.name !== "string" || !file.name || file.name.length > 255 || /[\\/:\u0000-\u001f\u007f]/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES || typeof (file.type || "") !== "string" || (file.type || "").length > 128)
        return Promise.reject(new Error("Invalid file"));
      if (!target || !["public", "private"].includes(target.type) || (target.type === "private" && (typeof target.id !== "string" || !target.id || target.id.length > 160)))
        return Promise.reject(new Error("Invalid file recipient"));
      return execute(() => send(file, target, options));
    },
    cancel(id) {
      if (typeof id !== "string" || !id) return Promise.reject(new Error("Invalid transfer"));
      return execute(() => cancel(id));
    },
    download(id) {
      if (typeof id !== "string" || !id) throw new Error("Invalid transfer");
      return download(id);
    },
    /** Release view observation only; the shared session owns transfer disposal. */
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      listeners.clear();
    },
  };
}
