import { createParticipantsSource } from "../participants/participantsModel.mjs";
import { MUSIC_ID, registryView } from "./roomState.mjs";

/** Bound on lobby entrants tracked from relays. */
const MAX_LOBBY = 1000;

/** Build the legacy room DTO the participants model decodes, from client state. */
export function roomFromState(state) {
  const view = registryView(state);
  const peers = view.participants.map((value) => [value.id, {
    peer_info: {
      peer_id: value.id,
      peer_name: value.bot ? "Бодрик FM" : value.name || "Participant",
      peer_avatar: value.bot ? "/images/bodrik-ava.png" : value.avatar,
      peer_presenter: value.presenter,
      peer_audio: value.audio,
      peer_video: value.video,
      peer_screen: value.screen,
      peer_bot: value.bot,
    },
  }]);
  return { peers: JSON.stringify(peers) };
}

/**
 * Participants/Lobby source for the React dock, backed by the meeting client.
 * Server actions (roles, moderation, lobby) go through Rust; pin, grid
 * visibility and volume are local layout; "chat" opens a private conversation.
 */
export function createMeetingParticipants({ client, layout, chat, slug, origin, onShare, confirm, layoutTransition = (change) => change(), clipboard = globalThis.navigator?.clipboard }) {
  let visible = false;
  let lobby = []; // { id, name, avatar, stamp }

  const state = () => client.getState();
  const stampOf = (id) => state().participants[id]?.stamp || lobby.find((entry) => entry.id === id)?.stamp;

  /** Map one validated view command to the client. */
  async function execute(command) {
    const self = state().selfId;
    switch (command.type) {
      case "chat":
        chat.setVisible(true);
        chat.selectConversation(null, command.targetId);
        return;
      case "role":
        return client.command({ type: "setRole", target: requireStamp(command.targetId), presenter: command.presenter });
      case "moderate":
        // A ban asks the room's confirmation dialog first (when the room provides one).
        if (command.action === "ban" && confirm && !(await confirm({ kind: "ban", name: state().participants[command.targetId]?.name || "" }))) return;
        return client.command({ type: "peerModeration", targets: [requireStamp(command.targetId)], action: command.action, message: null });
      case "moderateAll": {
        const targets = Object.values(state().participants).filter((value) => !value.bot && value.id !== self).map((value) => value.stamp);
        if (!targets.length) return;
        return client.command({ type: "peerModeration", targets, action: command.action, message: null });
      }
      case "lobby":
        return client.command({ type: "lobby", targets: [requireStamp(command.targetId)], accepted: command.accepted });
      case "pin":
        // Same animated focus change as clicking a card.
        layoutTransition(() => layout.pin(layout.getSnapshot().pinned === command.targetId ? "" : command.targetId));
        return;
      case "visibility":
        layout.setHidden(command.targetId, command.hidden);
        return;
      case "volume":
        layout.setVolume(command.targetId, command.value);
        return;
      case "invite":
        // The room's share dialog when available; otherwise copy the invitation link.
        if (onShare) onShare();
        else await clipboard.writeText(`${origin}/room/${encodeURIComponent(slug)}`);
        return;
      case "close":
        visible = false;
        source.refresh();
        return;
      default:
        throw new Error("Unsupported participant command");
    }
  }

  /** Current stamp for a participant or lobby entrant, or throw. */
  function requireStamp(id) {
    const stamp = stampOf(id);
    if (!stamp) throw new Error("Participant unavailable");
    return stamp;
  }

  const source = createParticipantsSource({
    requestRoom: async () => roomFromState(state()),
    getSession: () => state().selfId || null,
    getLanguage: () => state().language || "ru",
    getCapabilities: () => ({ selfId: state().selfId, presenter: state().presenter, visible, hidden: layout.getSnapshot().hidden, volumes: layout.getSnapshot().volumes }),
    execute,
    origin,
  });

  /** Push current participants into the model and keep layout in step. */
  function sync() {
    if (!state().selfId) return source.refresh();
    source.replaceRoom(roomFromState(state()));
    layout.retain(Object.keys(state().participants).concat(MUSIC_ID), state().participants);
  }

  /** Track lobby entrants announced to presenters. */
  function onEvent(kind, value) {
    if (kind !== "roomLobby" || !value) return;
    if (value.lobby_status === "waiting" && typeof value.peer_id === "string" && value.stamp) {
      lobby = [...lobby.filter((entry) => entry.id !== value.peer_id), { id: value.peer_id, name: value.peer_name || "Participant", avatar: value.peer_avatar || "", stamp: value.stamp }].slice(-MAX_LOBBY);
    } else if (value.lobby_status === "accept" || value.lobby_status === "reject") {
      const done = new Set(value.peers_id || (value.peer_id ? [value.peer_id] : []));
      lobby = lobby.filter((entry) => !done.has(entry.id));
    } else {
      return;
    }
    source.replaceLobby(lobby.map(({ id, name, avatar }) => ({ id, name, avatar })));
  }

  const offLayout = layout.subscribe(source.refresh);
  const offState = client.subscribe(sync);
  const offEvents = client.subscribeEvents(onEvent);
  sync();

  return {
    ...source,
    /** Toggle the dock. */
    toggle() {
      visible = !visible;
      source.refresh();
    },
    /** Stop observing the client. */
    dispose() {
      offLayout();
      offState();
      offEvents();
      source.dispose();
    },
  };
}
