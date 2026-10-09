/** How long a toast stays visible. */
const TOAST_MS = 4000;
/** A joiner's profile name arrives just after participantJoined; wait for it. */
const JOIN_NAME_MS = 1200;

/** RU/EN notification text. `{name}`/`{from}` are replaced with display names. */
const TEXT = {
  ru: {
    joined: "{name} присоединился к встрече",
    left: "{name} покинул встречу",
    presenterGranted: "{from} назначил вас ведущим",
    presenterRevoked: "{from} снял с вас роль ведущего",
    mute: "{from} выключил ваш микрофон",
    hide: "{from} выключил вашу камеру",
    stop: "{from} остановил вашу демонстрацию экрана",
    unmute: "{from} просит включить микрофон",
    unhide: "{from} просит включить камеру",
    start: "{from} просит начать демонстрацию экрана",
    lobby: "{name} ожидает в зале ожидания",
    file: "{name} отправляет файл",
    lock: "Комната защищена паролем",
    unlock: "Пароль комнаты снят",
    lobbyOn: "Зал ожидания включён",
    lobbyOff: "Зал ожидания выключен",
    joinLockOn: "Вход в комнату закрыт",
    joinLockOff: "Вход в комнату открыт",
  },
  en: {
    joined: "{name} joined the meeting",
    left: "{name} left the meeting",
    presenterGranted: "{from} made you a presenter",
    presenterRevoked: "{from} removed your presenter role",
    mute: "{from} muted your microphone",
    hide: "{from} turned off your camera",
    stop: "{from} stopped your screen share",
    unmute: "{from} asks you to unmute",
    unhide: "{from} asks you to turn on your camera",
    start: "{from} asks you to share your screen",
    lobby: "{name} is waiting in the lobby",
    file: "{name} is sending a file",
    lock: "The room is password protected",
    unlock: "The room password was removed",
    lobbyOn: "The lobby is on",
    lobbyOff: "The lobby is off",
    joinLockOn: "The room is locked",
    joinLockOff: "The room is unlocked",
  },
};

/**
 * Map one Rust event to `{ key, sound, severity, name?, from? }`, or null. `state` is
 * client state after the event (participants already updated) and `before` is the
 * state before it (needed for names of participants who left).
 */
export function notificationFor(kind, value, state, before) {
  const nameOf = (stamp, source = state) => source.participants[stamp?.sessionId]?.name || "Participant";
  const self = stamp => stamp?.sessionId === state.selfId;
  switch (kind) {
    case "participantJoined":
      return self(value?.participant) ? null : { key: "joined", sound: "joined", name: nameOf(value?.participant) };
    case "participantLeft":
      if (self(value?.participant) || !before.participants[value?.participant?.sessionId]) return null;
      return { key: "left", sound: "left", name: nameOf(value?.participant, before) };
    case "presenter":
      if (!self(value?.participant)) return null;
      return { key: value.presenter ? "presenterGranted" : "presenterRevoked", sound: "notify", from: nameOf(value.from) };
    case "peerAction":
      return ["mute", "hide", "stop", "unmute", "unhide", "start"].includes(value?.action)
        ? { key: value.action, sound: "alert", severity: "warning", from: nameOf(value.from) } : null;
    case "roomLobby":
      return value?.lobby_status === "waiting" && state.presenter ? { key: "lobby", sound: "lobby", name: value.peer_name || "Participant" } : null;
    case "fileOffer":
      return { key: "file", sound: "notify", name: nameOf(value?.sender) };
    case "chatMessage":
      return { key: "", sound: "message" };
    case "roomAction":
      return Object.hasOwn(TEXT.ru, value?.action) ? { key: value.action, sound: value.action === "lock" ? "locked" : "notify" } : null;
    default:
      return null;
  }
}

/** Fill a text template. */
function format(template, note) {
  return template.replace("{name}", note.name || "").replace("{from}", note.from || "");
}

/**
 * Toast source for MeetingNotifications plus event sounds. Sounds are played only when
 * the `sounds` preference is on; chat messages play a sound without a toast.
 */
export function createMeetingNotifications({ client, playSound, schedule = setTimeout, cancel = clearTimeout }) {
  let snapshot = null;
  let sequence = 0;
  let timer = null;
  // State listeners run before event listeners, so keep the state from before the latest change.
  let latest = client.getState();
  let previous = latest;
  const listeners = new Set();

  /** Show one toast. */
  function show(text, severity = "info") {
    cancel(timer);
    const id = ++sequence;
    snapshot = Object.freeze({ id, text, severity });
    listeners.forEach((listener) => listener());
    timer = schedule(() => {
      if (sequence !== id) return;
      snapshot = null;
      listeners.forEach((listener) => listener());
    }, TOAST_MS);
  }

  const offState = client.subscribe(() => {
    previous = latest;
    latest = client.getState();
  });
  const offEvents = client.subscribeEvents((kind, value) => {
    const state = client.getState();
    const note = notificationFor(kind, value, state, previous);
    if (!note) return;
    if (client.preferences.getSnapshot().sounds) playSound?.(note.sound);
    if (!note.key) return;
    if (note.key === "joined") {
      const id = value.participant.sessionId;
      schedule(() => {
        const current = client.getState();
        // Before a profile arrives the server may report the session id as the name.
        const raw = current.participants[id]?.name;
        const name = raw && raw !== id ? raw : current.language === "en" ? "A participant" : "Участник";
        if (current.participants[id]) show(format(TEXT[current.language === "en" ? "en" : "ru"].joined, { name }));
      }, JOIN_NAME_MS);
      return;
    }
    show(format(TEXT[state.language === "en" ? "en" : "ru"][note.key], note), note.severity);
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Show an arbitrary local notice (e.g. a failed action). */
    show,
    dispose() {
      cancel(timer);
      offState();
      offEvents();
      listeners.clear();
    },
  };
}
