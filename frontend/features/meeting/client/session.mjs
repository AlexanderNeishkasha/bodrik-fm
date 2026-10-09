import { retryDelay } from "./retryDelay.mjs";
import { PROTOCOL_VERSION } from "./protocol.mjs";

/** Default command timeout. */
const COMMAND_TIMEOUT_MS = 20_000;
/** First text frame must be a welcome within this window. */
const WELCOME_TIMEOUT_MS = 8_000;
/** Resume backoff ceilings; jitter cannot expand the existing delay budget. */
export const RECONNECT_DELAYS_MS = Object.freeze([500, 1000, 1500, 2500, 3500]);

/** Error carrying the server's result/error code. */
function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** Events that end this session: takeover by a newer session, or a kick/ban. */
function terminal(frame) {
  return frame.kind === "sessionReplaced" || (frame.kind === "peerAction" && ["eject", "ban"].includes(frame.value?.action));
}

/**
 * Own one meeting WebSocket session: admission, sequenced commands, contiguous events,
 * snapshot repair on revision gaps, bounded recovery and explicit leave.
 *
 * `onMessage` receives `{ type: "status", status }`, `{ type: "welcome", welcome }`,
 * `{ type: "event", kind, value }`, `{ type: "snapshot", snapshot }` and
 * `{ type: "binary", data }`.
 */
export function createMeetingSession({
  url,
  ownerProof,
  ticketProvider,
  onMessage,
  WebSocketImpl = globalThis.WebSocket,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
}) {
  let socket = null;
  let stamp = null;
  let sessionId = "";
  let recoveryToken = "";
  let revision = 0;
  let sequence = 1;
  let connected = false;
  let closed = false;
  let generation = 0;
  const pending = new Map();

  const emit = (message) => onMessage?.(message);
  const status = (value) => emit({ type: "status", status: value });

  /** Reject every in-flight command, e.g. after the socket closed. */
  function rejectPending(reason) {
    for (const entry of pending.values()) {
      clearTimer(entry.timer);
      entry.reject(codedError(reason, "disconnected"));
    }
    pending.clear();
  }

  /** Open one socket incarnation and resolve once a matching welcome arrives. */
  function open(hello) {
    const current = ++generation;
    const next = new WebSocketImpl(url);
    next.binaryType = "arraybuffer";
    socket = next;
    return new Promise((resolve, reject) => {
      let welcomed = false;
      const timer = setTimer(() => {
        if (welcomed) return;
        next.close();
        reject(codedError("Meeting connection timed out", "timeout"));
      }, WELCOME_TIMEOUT_MS);
      next.addEventListener("open", () => next.send(JSON.stringify(hello)));
      next.addEventListener("message", (event) => {
        if (current !== generation) return;
        if (welcomed) return receive(event);
        if (typeof event.data !== "string") return;
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (frame.type === "error") {
          clearTimer(timer);
          // Reject before closing: the close handler would otherwise win with a generic error.
          reject(codedError("Meeting admission denied", frame.code || "denied"));
          next.close();
          return;
        }
        if (frame.type !== "welcome" || frame.version !== PROTOCOL_VERSION || !frame.stamp?.sessionId) return;
        welcomed = true;
        clearTimer(timer);
        stamp = frame.stamp;
        sessionId = frame.stamp.sessionId;
        recoveryToken = frame.recoveryToken;
        revision = Number(frame.revision) || 0;
        sequence = 1;
        connected = true;
        emit({ type: "welcome", welcome: frame });
        resolve(frame);
      });
      next.addEventListener("close", () => {
        if (current !== generation) return;
        if (!welcomed) {
          clearTimer(timer);
          reject(codedError("Meeting connection closed", "closed"));
          return;
        }
        disconnected();
      });
    });
  }

  /** Route one post-welcome frame. */
  function receive(event) {
    if (typeof event.data !== "string") {
      emit({ type: "binary", data: event.data });
      return;
    }
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      socket?.close();
      return;
    }
    if (frame.version !== PROTOCOL_VERSION || frame.stamp?.sessionId !== sessionId) return;
    if (frame.type === "result") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      clearTimer(entry.timer);
      if (frame.ok) entry.resolve(frame.value);
      else entry.reject(codedError(frame.error?.code || "Meeting command failed", frame.error?.code));
      return;
    }
    if (frame.type !== "event") return;
    // A session-ending event is the server's last frame and may follow events it had to
    // drop, so it is delivered even across a revision gap instead of triggering repair.
    if (terminal(frame)) {
      emit({ type: "event", kind: frame.kind, value: frame.value });
      return;
    }
    if (frame.revision !== revision + 1) {
      repair();
      return;
    }
    revision = frame.revision;
    emit({ type: "event", kind: frame.kind, value: frame.value });
  }

    /** Replace the projection from an authoritative snapshot after a revision gap. */
  function repair() {
    command({ type: "snapshot" })
      .then((snapshot) => {
        revision = Number(snapshot?.revision) || revision;
        emit({ type: "snapshot", snapshot });
      })
      .catch(() => socket?.close());
  }

  /** Handle an unexpected close: fail pending commands and attempt bounded recovery. */
  function disconnected() {
    if (!connected) return;
    connected = false;
    rejectPending("Meeting disconnected");
    if (closed) return;
    status("reconnecting");
    recover();
  }

  /** Resume the same session within the server grace window. */
  async function recover() {
    for (const delay of RECONNECT_DELAYS_MS) {
      await new Promise((resolve) => setTimer(resolve, retryDelay(delay, random)));
      if (closed) return;
      try {
        await open({ type: "resume", version: PROTOCOL_VERSION, sessionId, recoveryToken, ownerProof });
        status("admitted");
        return;
      } catch {
        // Try again until the delays are exhausted.
      }
    }
    if (!closed) status("failed");
  }

  /** Send one sequenced command and resolve with its exact result value. */
  function command(action, timeout = COMMAND_TIMEOUT_MS) {
    if (!connected || socket?.readyState !== WebSocketImpl.OPEN) {
      return Promise.reject(codedError("Meeting disconnected", "disconnected"));
    }
    const id = sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(id);
        reject(codedError("Meeting command timed out", "timeout"));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "command", version: PROTOCOL_VERSION, id, stamp, action }));
    });
  }

  return {
    /** Admit with a fresh player ticket. */
    async connect() {
      closed = false;
      status("connecting");
      const ticket = await ticketProvider();
      return open({ type: "admit", version: PROTOCOL_VERSION, ticket, ownerProof });
    },
    command,
    /** Send one binary file-transfer frame. */
    sendBinary(frame) {
      if (!connected) return Promise.reject(codedError("Meeting disconnected", "disconnected"));
      socket.send(frame);
      return Promise.resolve();
    },
    /**
     * Leave and suppress recovery. `notify: false` only drops the socket: the server
     * keeps the session for its short grace period, so a reload can take it over.
     */
    async leave({ notify = true } = {}) {
      closed = true;
      if (connected && notify) await command({ type: "leave" }).catch(() => {});
      connected = false;
      rejectPending("Meeting left");
      generation++;
      socket?.close();
      status("left");
    },
    /** Current own session id ("" before welcome). */
    get sessionId() {
      return sessionId;
    },
    /** Owner proof; also the bearer credential for this session's uploads. */
    ownerProof,
    /** Current own public stamp (null before welcome). */
    get stamp() {
      return stamp;
    },
  };
}
