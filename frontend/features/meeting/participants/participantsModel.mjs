import { safeChatAvatar } from "../chat/chatAvatar.mjs";

/** Stable empty local grid visibility for sources without layout observations. */
const EMPTY_HIDDEN = Object.freeze([]);
/** Stable default when the source has no local playback overrides. */
const EMPTY_VOLUMES = Object.freeze({});

/** Limit retained public participant snapshots before parsing or projecting server-visible peer metadata. */
const MAX_PEERS = 1000;
/** Bound one legacy room peers JSON field; never retain the original credential/resource-bearing envelope. */
const MAX_PEERS_JSON = 2 * 1024 * 1024;
/** Maximum pending lobby entries accepted from the retained runtime. */
const MAX_LOBBY = 1000;
/** UI statuses copied from the current server peer projection, not inferred from DOM/media elements. */
const statuses = Object.freeze({
  presenter: "peer_presenter",
  audio: "peer_audio",
  video: "peer_video",
  screen: "peer_screen",
  bot: "peer_bot",
});
/** Commands exposed by the participants view; the retained runtime and Rust server still authorize them. */
const commandTypes = new Set([
  "chat",
  "role",
  "moderate",
  "lobby",
  "pin",
  "visibility",
  "volume",
  "invite",
  "moderateAll",
  "close",
]);

/** Require bounded nonempty identifiers/labels before they enter React keys or accessible participant text. */
function text(value, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum)
    throw new Error("Invalid participant text");
  return value;
}

/** Normalize one allowlisted avatar URL without retaining arbitrary remote or credential-bearing values. */
function avatar(value, origin, bot) {
  if (bot === true && value === "/images/bodrik-ava.png") {
    try {
      const base = new URL(origin);
      const url = new URL(value, base);
      if (url.origin === base.origin && !url.username && !url.password && !url.search && !url.hash)
        return url.href;
    } catch {}
  }
  return safeChatAvatar(value, origin);
}

/** Normalize the active getRoomInfo peers wire field; only allowlisted UI scalars survive the boundary. */
export function decodeParticipants(room, { origin = "https://meeting.invalid" } = {}) {
  if (
    !room ||
    typeof room.peers !== "string" ||
    room.peers.length > MAX_PEERS_JSON
  )
    throw new Error("Invalid participant snapshot");
  const input = JSON.parse(room.peers);
  if (!Array.isArray(input) || input.length > MAX_PEERS)
    throw new Error("Invalid participant list");
  const ids = new Set();
  return Object.freeze(
    input.map((entry) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !entry[1] ||
        typeof entry[1] !== "object"
      )
        throw new Error("Invalid participant entry");
      const id = text(entry[0], 160);
      const info = entry[1].peer_info;
      if (
        !info ||
        typeof info !== "object" ||
        Array.isArray(info) ||
        info.peer_id !== id ||
        ids.has(id)
      )
        throw new Error("Invalid participant identity");
      ids.add(id);
      const flags = Object.fromEntries(
        Object.entries(statuses).map(([key, field]) => {
          if (info[field] !== undefined && typeof info[field] !== "boolean")
            throw new Error("Invalid participant status");
          return [key, info[field] === true];
        }),
      );
      return Object.freeze({
        id,
        name: text(info.peer_name, 256),
        avatar: avatar(info.peer_avatar, origin, flags.bot),
        volume: 100,
        ...flags,
      });
    }),
  );
}

/** Normalize presenter-visible lobby observations without copying stamps or transport credentials. */
function decodeLobby(input, { origin = "https://meeting.invalid" } = {}) {
  if (!Array.isArray(input) || input.length > MAX_LOBBY)
    throw new Error("Invalid lobby list");
  const ids = new Set();
  return Object.freeze(input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid lobby participant");
    const id = text(entry.id, 160);
    if (ids.has(id)) throw new Error("Invalid lobby participant");
    ids.add(id);
    return Object.freeze({
      id,
      name: text(entry.name, 256),
      avatar: avatar(entry.avatar, origin),
    });
  }));
}

/** Bound the local waiter when an injected request ignores abort; late replies are discarded. */
function waitForRoom(requestRoom, signal, timeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** Release the deadline/listener exactly once, without retry or a remote-cancellation claim. */
    function finish(failure, room) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve(room);
    }
    const timer = setTimeout(
      () => finish(new Error("Participant snapshot request timed out")),
      timeout,
    );
    const abort = () =>
      finish(new DOMException("Participant request cancelled locally", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    Promise.resolve().then(() => requestRoom(signal)).then(
      (room) => finish(null, room),
      (failure) => finish(failure),
    );
  });
}

/** Validate one view command before passing it to the caller-owned runtime. */
function command(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !commandTypes.has(value.type))
    throw new Error("Invalid participant command");
  if (value.targetId !== undefined) text(value.targetId, 160);
  if (value.type === "role" && typeof value.presenter !== "boolean")
    throw new Error("Invalid role command");
  if (value.type === "moderate" && !["mute", "hide", "stop", "ban", "eject"].includes(value.action))
    throw new Error("Invalid moderation command");
  if (value.type === "lobby" && typeof value.accepted !== "boolean")
    throw new Error("Invalid lobby command");
  if (value.type === "visibility" && typeof value.hidden !== "boolean")
    throw new Error("Invalid visibility command");
  if (value.type === "volume" && (!Number.isInteger(value.value) || value.value < 0 || value.value > 100))
    throw new Error("Invalid volume command");
  if (value.type === "moderateAll" && !["mute", "hide", "stop", "eject"].includes(value.action))
    throw new Error("Invalid room moderation command");
  return Object.freeze({ ...value });
}

/** Own a sanitized participant projection while the caller retains socket, media and authorization ownership. */
export function createParticipantsSource({
  requestRoom,
  getSession,
  getLanguage,
  getCapabilities = () => ({}),
  execute = () => Promise.reject(new Error("Participant commands unavailable")),
  origin = "https://meeting.invalid",
  timeout = 15000,
}) {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 15000)
    throw new Error("Invalid participant request deadline");
  const listeners = new Set();
  let peers = Object.freeze([]);
  let lobby = Object.freeze([]);
  let snapshot;
  let observedSession = getSession();
  let pending = null;
  let pendingCommand = null;
  let error = null;
  let actionError = null;
  let disposed = false;

  /** Publish an immutable state snapshot and fence projections when session ownership changes. */
  function refresh() {
    if (disposed) return;
    const current = getSession();
    if (current !== observedSession) {
      observedSession = current;
      peers = Object.freeze([]);
      lobby = Object.freeze([]);
      error = null;
      actionError = null;
      const obsolete = pending;
      pending = null;
      obsolete?.controller.abort();
    }
    const capabilities = getCapabilities() || {};
    const next = {
      peers,
      lobby,
      available: Boolean(current),
      pending: !!pending,
      pendingCommand,
      error,
      actionError,
      language: getLanguage() === "en" ? "en" : "ru",
      selfId: typeof capabilities.selfId === "string" ? capabilities.selfId : "",
      presenter: capabilities.presenter === true,
      visible: capabilities.visible === true,
      hidden: capabilities.hidden || EMPTY_HIDDEN,
      volumes: capabilities.volumes || EMPTY_VOLUMES,
    };
    if (snapshot && Object.keys(next).every((key) => next[key] === snapshot[key])) return;
    snapshot = Object.freeze(next);
    listeners.forEach((listener) => listener());
  }
  refresh();

  /** Commit one decoded room projection supplied by an already-authoritative retained observation. */
  function replaceRoom(room) {
    if (disposed) return false;
    refresh();
    if (!getSession()) return false;
    peers = decodeParticipants(room, { origin });
    error = null;
    refresh();
    return true;
  }

  /** Commit one decoded lobby projection supplied by the retained runtime. */
  function replaceLobby(entries) {
    if (disposed) return false;
    refresh();
    if (!getSession()) return false;
    lobby = decodeLobby(entries, { origin });
    refresh();
    return true;
  }

  return {
    /** Read an immutable sanitized DTO; observed roles remain display/capability hints, never authorization. */
    getSnapshot: () => snapshot,
    /** Bind a view observer only; the caller owns the admitted session and request transport. */
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    replaceRoom,
    replaceLobby,
    /** Fetch once per explicit refresh, coalescing concurrent views and rejecting obsolete completions. */
    reload() {
      if (disposed) return Promise.reject(new Error("Participants source disposed"));
      refresh();
      const session = getSession();
      if (!session) return Promise.reject(new Error("Participants session unavailable"));
      if (pending) return pending.promise;
      const operation = { controller: new AbortController(), promise: null };
      pending = operation;
      error = null;
      operation.promise = (async () => {
        try {
          const room = await waitForRoom(requestRoom, operation.controller.signal, timeout);
          if (disposed || operation.controller.signal.aborted || session !== getSession())
            throw new DOMException("Participant session changed", "AbortError");
          peers = decodeParticipants(room, { origin });
        } catch (failure) {
          if (!disposed && session === getSession() && failure.name !== "AbortError") error = "unavailable";
          throw failure;
        } finally {
          if (pending === operation) pending = null;
          refresh();
        }
      })();
      refresh();
      return operation.promise;
    },
    /** Execute one serialized participant action; server/runtime denial remains an explicit failure. */
    async execute(value) {
      if (disposed) throw new Error("Participants source disposed");
      refresh();
      const session = getSession();
      if (!session) throw new Error("Participants session unavailable");
      if (pendingCommand) throw new Error("Participant action already pending");
      const next = command(value);
      pendingCommand = `${next.type}:${next.targetId || next.action || "all"}`;
      actionError = null;
      refresh();
      try {
        const result = await execute(next);
        if (disposed || session !== getSession())
          throw new DOMException("Participant session changed", "AbortError");
        return result;
      } catch (failure) {
        if (!disposed && session === getSession() && failure.name !== "AbortError") actionError = "rejected";
        throw failure;
      } finally {
        pendingCommand = null;
        refresh();
      }
    },
    /** Invalidate local waits/observers only; view disposal never leaves the shared call. */
    dispose() {
      if (disposed) return;
      disposed = true;
      pending?.controller.abort();
      listeners.clear();
    },
  };
}
