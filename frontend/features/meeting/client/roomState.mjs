/** Fixed participant id of the server-owned room music source. */
export const MUSIC_ID = "bodrik-music";

/** Rust media types mapped to registry source kinds. */
const KIND_BY_MEDIA_TYPE = Object.freeze({ audioType: "audio", videoType: "camera", screenType: "screen" });

/** Welcome phases mapped to client status. */
const STATUS_BY_PHASE = Object.freeze({
  admitted: "admitted",
  lobby: "lobby",
  password: "password",
  joinLocked: "joinLocked",
  banned: "banned",
});

/** Bound on producer-state changes that arrive before their producerCreated. */
const EARLY_LIMIT = 64;

/** Initial client state before admission. */
export const initialRoomState = Object.freeze({
  status: "idle",
  selfId: "",
  presenter: false,
  count: 0,
  speakerId: "",
  musicVolume: 1,
  // Logical bot presence survives replaceable RTP producer restarts.
  musicConnected: false,
  // True once the first media inventory after admission is in (all initial cards known).
  loaded: false,
  participants: Object.freeze({}),
  producers: Object.freeze({}),
  early: Object.freeze({}),
});

/** Build one participant record from server-owned fields. */
function participant(stamp, name, avatar, presenter, previous) {
  return Object.freeze({
    id: stamp.sessionId,
    stamp,
    name: typeof name === "string" ? name : previous?.name || "",
    avatar: typeof avatar === "string" ? avatar : previous?.avatar || "",
    presenter: typeof presenter === "boolean" ? presenter : previous?.presenter === true,
    bot: false,
  });
}

/** Server-owned room music participant, present while conference output is connected. */
const musicParticipant = Object.freeze({
  id: MUSIC_ID,
  stamp: null,
  name: "Бодрик FM",
  avatar: "/images/bodrik-ava.png",
  presenter: false,
  bot: true,
});

/** Build one producer record from a producerCreated value or inventory entry. */
function producer(source, early) {
  const participantId = source.participant?.sessionId;
  const kind = KIND_BY_MEDIA_TYPE[source.mediaType];
  if (typeof source.producerId !== "string" || typeof participantId !== "string" || !kind) return null;
  const held = early[source.producerId];
  const paused = typeof source.paused === "boolean" ? source.paused : held?.participantId === participantId ? held.paused : false;
  return Object.freeze({ id: source.producerId, participantId, kind, paused, system: source.system === "music" });
}

/** Return a frozen copy of an object without one key. */
function without(record, key) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return Object.freeze(next);
}

/** Return a frozen copy of an object with one key set. */
function withEntry(record, key, value) {
  return Object.freeze({ ...record, [key]: value });
}

/** Drop producers whose owner is no longer present (music is server-owned and kept). */
function retainProducers(producers, participants) {
  const next = Object.fromEntries(
    Object.entries(producers).filter(([, value]) => value.system || participants[value.participantId]),
  );
  return Object.freeze(next);
}

/** Add one producer; only human sources can introduce participant membership. */
function addProducer(state, source) {
  const value = producer(source, state.early);
  if (!value) return state;
  let { participants } = state;
  if (!value.system && !participants[value.participantId]) {
    participants = withEntry(participants, value.participantId, participant(source.participant, source.name, source.avatar));
  }
  return {
    ...state,
    participants,
    producers: withEntry(state.producers, value.id, value),
    early: without(state.early, value.id),
    musicVolume: value.system && Number.isFinite(source.volume) ? source.volume : state.musicVolume,
    musicConnected: value.system || state.musicConnected,
  };
}

/** Apply one relayed pause/resume; early changes are held per producer (bounded). */
function producerState(state, value) {
  if (typeof value?.paused !== "boolean" || typeof value.producerId !== "string") return state;
  const owner = value.participant?.sessionId;
  const current = state.producers[value.producerId];
  if (!current) {
    if (typeof owner !== "string") return state;
    const entries = Object.entries(state.early).filter(([id]) => id !== value.producerId).slice(-(EARLY_LIMIT - 1));
    return { ...state, early: Object.freeze(Object.fromEntries([...entries, [value.producerId, { participantId: owner, paused: value.paused }]])) };
  }
  if (current.participantId !== owner || current.paused === value.paused) return state;
  return { ...state, producers: withEntry(state.producers, current.id, Object.freeze({ ...current, paused: value.paused })) };
}

/** Remove one closed source without changing participant membership. */
function closeProducer(state, producerId) {
  return { ...state, producers: without(state.producers, producerId), early: without(state.early, producerId) };
}

/** Apply one Rust event. Unknown kinds are ignored. */
function applyEvent(state, kind, value) {
  switch (kind) {
    case "participantJoined": {
      const stamp = value?.participant;
      if (typeof stamp?.sessionId !== "string") return state;
      const previous = state.participants[stamp.sessionId];
      const next = participant(stamp, value.name, value.avatar, value.presenter === true, previous);
      return { ...state, count: Number(value.count) || state.count, participants: withEntry(state.participants, next.id, next) };
    }
    case "participantLeft": {
      const id = value?.participant?.sessionId;
      const participants = without(state.participants, id);
      return { ...state, count: Number(value?.count) || 0, participants, producers: retainProducers(state.producers, participants) };
    }
    case "participantCount":
      return { ...state, count: Number(value?.count) || 0 };
    case "participantProfile": {
      const current = state.participants[value?.participant?.sessionId];
      if (!current || !["name", "avatar"].includes(value.field) || typeof value.value !== "string") return state;
      return { ...state, participants: withEntry(state.participants, current.id, Object.freeze({ ...current, [value.field]: value.value })) };
    }
    case "presenter": {
      const id = value?.participant?.sessionId;
      const current = state.participants[id];
      const presenter = value.presenter === true;
      return {
        ...state,
        presenter: id === state.selfId ? presenter : state.presenter,
        participants: current ? withEntry(state.participants, id, Object.freeze({ ...current, presenter })) : state.participants,
      };
    }
    case "producerCreated":
      return addProducer(state, value || {});
    case "producerClosed":
      return closeProducer(state, value?.resourceId);
    case "musicDisconnected":
      return state.musicConnected ? { ...state, musicConnected: false } : state;
    case "producerState":
      return producerState(state, value);
    case "dominantSpeaker":
      return { ...state, speakerId: value?.owner?.sessionId || "" };
    case "musicVolume":
      return Number.isFinite(value?.volume) ? { ...state, musicVolume: value.volume } : state;
    default:
      return state;
  }
}

/** Replace human participants from an authoritative snapshot; the bot is derived separately. */
function applySnapshot(state, snapshot) {
  if (!Array.isArray(snapshot?.peers)) return state;
  const entries = snapshot.peers
    .filter((peer) => typeof peer?.stamp?.sessionId === "string")
    .map((peer) => [peer.stamp.sessionId, participant(peer.stamp, peer.name, peer.avatar, peer.presenter === true)]);
  const participants = Object.freeze(Object.fromEntries(entries));
  const self = participants[state.selfId];
  return {
    ...state,
    count: Number(snapshot.count) || entries.length,
    presenter: self ? self.presenter : state.presenter,
    participants,
    producers: retainProducers(state.producers, participants),
  };
}

/** Replace the remote producer inventory with an authoritative `producers` result. */
function applyInventory(state, sources) {
  if (!Array.isArray(sources)) return state;
  const local = Object.entries(state.producers).filter(([, value]) => value.participantId === state.selfId);
  let next = { ...state, producers: Object.freeze(Object.fromEntries(local)) };
  for (const source of sources) next = addProducer(next, source || {});
  return next;
}

/** Add or update one local producer owned by this client. */
function localProducer(state, { id, kind, paused }) {
  if (typeof id !== "string" || !Object.values(KIND_BY_MEDIA_TYPE).includes(kind) || !state.selfId) return state;
  const value = Object.freeze({ id, participantId: state.selfId, kind, paused: paused === true, system: false });
  return { ...state, producers: withEntry(state.producers, id, value) };
}

/**
 * Pure reducer for meeting client state. Actions: `status`, `welcome`, `snapshot`,
 * `inventory` (producers result), `event` (Rust event kind/value), `localProducer`,
 * `localProducerClosed`, `reset`.
 */
export function reduceRoomState(state, action) {
  switch (action?.type) {
    case "status":
      return { ...state, status: action.status };
    case "welcome": {
      const welcome = action.welcome;
      return {
        ...state,
        selfId: welcome.stamp.sessionId,
        presenter: welcome.presenter === true,
        status: STATUS_BY_PHASE[welcome.phase] || "denied",
      };
    }
    case "snapshot":
      return applySnapshot(state, action.snapshot);
    case "inventory": {
      const next = applyInventory(state, action.sources);
      return next.loaded ? next : { ...next, loaded: true };
    }
    case "event":
      return applyEvent(state, action.kind, action.value);
    case "localProducer":
      return localProducer(state, action);
    case "localProducerClosed":
      return state.producers[action.id] ? { ...state, producers: without(state.producers, action.id) } : state;
    case "reset":
      return initialRoomState;
    default:
      return state;
  }
}

/** Project human membership and logical music-bot presence independently of source replacement. */
export function registryView(state) {
  const producers = Object.values(state.producers);
  const sourcesFor = (id) => producers.filter((value) => value.participantId === id || (id === MUSIC_ID && value.system));
  const members = Object.values(state.participants);
  if (["admitted", "reconnecting"].includes(state.status) && state.musicConnected && !state.participants[MUSIC_ID]) members.push(musicParticipant);
  const ordered = members.sort((a, b) => rank(a, state) - rank(b, state));
  const participants = ordered.map((value) => {
    const own = sourcesFor(value.id);
    const active = (kind) => own.some((source) => source.kind === kind && !source.paused);
    return {
      id: value.id,
      name: value.name,
      avatar: value.avatar,
      presenter: value.presenter,
      bot: value.bot,
      audio: active("audio"),
      video: active("camera"),
      screen: active("screen"),
      speaking: value.id === state.speakerId,
    };
  });
  const present = new Set(participants.map((value) => value.id));
  const sources = Object.values(state.producers).filter((value) => present.has(value.system ? MUSIC_ID : value.participantId)).map((value) => ({
    id: value.id,
    participantId: value.system ? MUSIC_ID : value.participantId,
    kind: value.kind,
    paused: value.paused,
    local: value.participantId === state.selfId,
  }));
  return { participants, sources };
}

/** Sort key: self, then others in insertion order, then music. */
function rank(value, state) {
  if (value.id === state.selfId) return 0;
  return value.bot ? 2 : 1;
}
