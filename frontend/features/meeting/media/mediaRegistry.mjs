import { safeChatAvatar } from "../chat/chatAvatar.mjs";

/** Bound participants and media sources retained by the React projection. */
const MAX_ENTRIES = 1000;

/** Require a bounded identifier before it enters registry keys or DOM attributes. */
function id(value) {
  if (typeof value !== "string" || !value || value.length > 160) throw new Error("Invalid media identifier");
  return value;
}

/** Accept only the relative uploaded-avatar paths shared with the participant panel. */
function avatarPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "";
  const safe = safeChatAvatar(value, "https://meeting.invalid");
  return safe ? new URL(safe).pathname : "";
}

/** Normalize one participant/source observation without retaining transport credentials. */
function normalizeParticipant(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid participant");
  return Object.freeze({
    id: id(value.id),
    name: typeof value.name === "string" && value.name.length <= 256 ? value.name : "",
    avatar: avatarPath(value.avatar),
    presenter: value.presenter === true,
    audio: value.audio === true,
    video: value.video === true,
    screen: value.screen === true,
    speaking: value.speaking === true,
    bot: value.bot === true,
  });
}

/** Normalize one media source while leaving its caller-owned MediaStreamTrack outside snapshots. */
function normalizeSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid media source");
  const kind = value.kind;
  if (!["audio", "camera", "screen"].includes(kind)) throw new Error("Invalid media kind");
  return Object.freeze({
    id: id(value.id),
    participantId: id(value.participantId),
    kind,
    paused: value.paused === true,
    local: value.local === true,
    consumerId: value.consumerId === undefined || value.consumerId === "" ? "" : id(value.consumerId),
  });
}

/** Own one immutable, idempotent participant/source projection for React views. */
export function createMediaRegistry({ onVideoVisibility } = {}) {
  const participants = new Map();
  const sources = new Map();
  const tracks = new Map();
  const listeners = new Set();
  let snapshot = Object.freeze({ participants: Object.freeze([]), sources: Object.freeze([]), trackRevision: 0 });
  let disposed = false;
  let trackRevision = 0;

  /** Publish only when normalized state changed. */
  function publish() {
    const next = Object.freeze({
      participants: Object.freeze([...participants.values()]),
      sources: Object.freeze([...sources.values()]),
      trackRevision,
    });
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return false;
    snapshot = next;
    listeners.forEach((listener) => listener());
    return true;
  }

  return {
    /** Report visibility to the media owner; snapshots remain the sole registry state. */
    setVideoVisible: (sourceId, visible) => { if (!disposed) onVideoVisibility?.(sourceId, visible); },
    getSnapshot: () => snapshot,
    getTrack: (sourceId) => tracks.get(sourceId) || null,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace(nextParticipants, nextSources = []) {
      if (disposed || !Array.isArray(nextParticipants) || !Array.isArray(nextSources) || nextParticipants.length > MAX_ENTRIES || nextSources.length > MAX_ENTRIES)
        throw new Error("Invalid media snapshot");
      const normalizedParticipants = nextParticipants.map(normalizeParticipant);
      const normalizedSources = nextSources.map(normalizeSource);
      const participantIds = new Set(normalizedParticipants.map((entry) => entry.id));
      if (participantIds.size !== normalizedParticipants.length || normalizedSources.some((entry) => !participantIds.has(entry.participantId)))
        throw new Error("Invalid media ownership");
      const sourceIds = new Set(normalizedSources.map((entry) => entry.id));
      if (sourceIds.size !== normalizedSources.length) throw new Error("Invalid media ownership");
      participants.clear();
      sources.clear();
      normalizedParticipants.forEach((entry) => participants.set(entry.id, entry));
      normalizedSources.forEach((entry) => sources.set(entry.id, entry));
      for (const sourceId of tracks.keys()) if (!sourceIds.has(sourceId)) tracks.delete(sourceId);
      return publish();
    },
    attachTrack(sourceId, track) {
      if (disposed || !sources.has(sourceId)) return false;
      if (!track || typeof track !== "object") throw new Error("Invalid media track");
      if (tracks.get(sourceId) === track) return false;
      tracks.set(sourceId, track);
      trackRevision += 1;
      publish();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      participants.clear();
      sources.clear();
      tracks.clear();
      listeners.clear();
    },
  };
}
