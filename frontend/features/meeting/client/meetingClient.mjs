import { READMIT_DELAYS_MS, retryDelay } from "./retryDelay.mjs";
import { createMediaRegistry } from "../media/mediaRegistry.mjs";
import { normalizeAvatar } from "./avatarImage.mjs";
import { createCapture } from "./capture.mjs";
import { createLayout } from "./layout.mjs";
import { createPreferences } from "./preferences.mjs";
import { backgroundSupported, noiseSuppressionSupported, processBackground, processNoise } from "./processing.mjs";
import { createMeetingMedia } from "./media.mjs";
import { createOwnerProof, meetingEndpoint, profileAvatarPath, requestGuestTicket } from "./protocol.mjs";
import { initialRoomState, reduceRoomState, registryView } from "./roomState.mjs";
import { joinChoiceForRetry } from "./retryChoice.mjs";
import { createMeetingSession } from "./session.mjs";

export { READMIT_DELAYS_MS } from "./retryDelay.mjs";

/** localStorage when accessible; reading it throws in some privacy modes. */
function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Create the single owner of one meeting: session, state store, media and the
 * media registry the card views read. Nothing here runs at import time.
 */
export function createMeetingClient({
  slug,
  location = globalThis.location,
  crypto = globalThis.crypto,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  WebSocketImpl = globalThis.WebSocket,
  createDevice,
  mediaDevices = globalThis.navigator?.mediaDevices,
  storage = browserStorage(),
  setTimer,
  clearTimer,
  random = Math.random,
  hostGrant = "",
} = {}) {
  // The Studio host pass is single-use: only the first ticket request carries it; later
  // tickets rely on the backend remembering this browser as a host.
  let pendingHostGrant = hostGrant;
  let state = initialRoomState;
  const listeners = new Set();
  const eventListeners = new Set();
  const binaryListeners = new Set();
  const registry = createMediaRegistry({ onVideoVisibility: (id, visible) => media.setVideoVisible(id, visible) });
  const local = new Map(); // kind -> producerId
  const processors = new Map(); // kind -> { track, dispose } between capture and publish
  const capture = createCapture({ mediaDevices, storage });
  const layout = createLayout({ storage, slug });
  const preferences = createPreferences({ storage });
  const wait = (ms) => new Promise((resolve) => (setTimer || setTimeout)(resolve, ms));
  let profile = { name: "", avatar: "" };
  let choice = { audio: true, video: true };
  let retryChoice = null;
  let entering = null;
  let leaving = false;
  let readmitting = false;
  // Set once leave() disposed the registry; later status changes must not touch it.
  let registryClosed = false;

  /** Mirror state into the registry and attach every available track. */
  function syncRegistry() {
    if (registryClosed) return;
    const view = registryView(state);
    registry.replace(view.participants, view.sources);
    for (const source of view.sources) {
      const track = media.trackFor(source.id);
      if (track) registry.attachTrack(source.id, track);
    }
  }

  /** Apply one reducer action and notify subscribers when state changed. */
  function dispatch(action) {
    const next = reduceRoomState(state, action);
    if (next === state) return;
    state = next;
    syncRegistry();
    media.reconcile(state);
    for (const listener of [...listeners]) listener();
  }

  const session = createMeetingSession({
    random,
    url: meetingEndpoint(slug, location),
    ownerProof: createOwnerProof(crypto),
    ticketProvider: () => {
      const grant = pendingHostGrant;
      pendingHostGrant = "";
      return requestGuestTicket(slug, { fetchImpl, hostGrant: grant });
    },
    WebSocketImpl,
    ...(setTimer && { setTimer }),
    ...(clearTimer && { clearTimer }),
    onMessage(message) {
      // During readmission the old session's "left"/"failed" are internal steps, not outcomes.
      if (message.type === "status" && readmitting && message.status !== "admitted") return;
      if (message.type === "status" && message.status === "failed" && !leaving) {
        readmit();
        return;
      }
      if (message.type === "binary") {
        for (const listener of [...binaryListeners]) listener(message.data);
        return;
      }
      if (message.type === "status") dispatch({ type: "status", status: message.status });
      else if (message.type === "welcome") dispatch({ type: "welcome", welcome: message.welcome });
      else if (message.type === "snapshot") dispatch({ type: "snapshot", snapshot: message.snapshot });
      else if (message.type === "event") {
        dispatch({ type: "event", kind: message.kind, value: message.value });
        if (message.kind === "peerAction") moderated(message.value?.action);
        // The same browser/account joined again elsewhere (refresh, another tab): end here.
        if (message.kind === "sessionReplaced") api.leave().finally(() => dispatch({ type: "status", status: "replaced" }));
        if (message.kind === "roomLobby") lobbyDecision(message.value);
        for (const listener of [...eventListeners]) listener(message.kind, message.value);
      }
      if (message.type === "status" && message.status === "admitted") {
        refresh().catch(() => {});
        media.refreshIceConfig().catch(() => { if (!leaving) readmit(); });
      }
    },
  });

  /** Create one media owner bound to the current session. */
  function createMedia() {
    return createMeetingMedia({
      command: (action) => session.command(action),
      createDevice,
      onTracksChanged: syncRegistry,
      onTransportFailed: () => readmit(),
      ...(setTimer && { setTimer }),
      ...(clearTimer && { clearTimer }),
      random,
    });
  }
  let media = createMedia();

  /** Reload participants and remote producers from the server. */
  async function refresh() {
    dispatch({ type: "snapshot", snapshot: await session.command({ type: "snapshot" }) });
    dispatch({ type: "inventory", sources: await session.command({ type: "producers" }) });
  }

  /** Publish one captured track, optionally paused. */
  async function publishLocal(kind, track, paused = false) {
    const producerId = await media.publish(track, kind);
    local.set(kind, producerId);
    if (paused) await media.setPaused(producerId, true);
    dispatch({ type: "localProducer", id: producerId, kind, paused });
  }

  /**
   * Apply a presenter's moderation of this participant. Disable requests take effect;
   * enable requests need consent and are left to the UI; eject ("kicked") and ban end the meeting.
   */
  function moderated(action) {
    if (action === "mute") api.setMicrophoneMuted(true).catch(() => {});
    else if (action === "hide") stopLocal("camera").catch(() => {});
    else if (action === "stop") stopLocal("screen").catch(() => {});
    else if (action === "eject" || action === "ban") {
      const status = action === "ban" ? "banned" : "kicked";
      api.leave().finally(() => dispatch({ type: "status", status }));
    }
  }

  /**
   * Run the selected processing (RNNoise, background) on a raw capture track and
   * return the track to publish. Failure falls back to the raw track.
   */
  async function prepare(kind, raw) {
    processors.get(kind)?.dispose();
    processors.delete(kind);
    const prefs = capture.preferences;
    try {
      let handle = null;
      if (kind === "audio" && prefs.noiseMode === "rnnoise" && noiseSuppressionSupported()) handle = await processNoise(raw);
      if (kind === "camera" && prefs.backgroundMode !== "off" && backgroundSupported()) {
        handle = await processBackground(raw, { mode: prefs.backgroundMode });
      }
      if (!handle) return raw;
      processors.set(kind, handle);
      return handle.track;
    } catch {
      // Reported to views through capture status; the raw track keeps the call working.
      capture.setStatus("", "processing");
      return raw;
    }
  }

  /** Track currently published (or to publish) for a kind: processed if active, else raw. */
  const outgoing = (kind) => processors.get(kind)?.track || capture.track(kind);

  /** Re-run processing for a live kind and swap the result into its producer. */
  async function reprocess(kind) {
    const raw = capture.track(kind);
    if (!raw) return;
    const track = await prepare(kind, raw);
    const producerId = local.get(kind);
    if (producerId) await media.replaceTrack(producerId, track);
  }

  /** Capture and publish one local source kind (audio, camera or screen). */
  async function startLocal(kind) {
    if (local.has(kind)) return;
    // Reuse the prejoin preview track when it is still live.
    const preview = capture.track(kind);
    const track = preview && preview.readyState !== "ended" ? preview : await capture.acquire(kind);
    if (!track) throw new DOMException("Capture cancelled", "AbortError");
    try {
      await publishLocal(kind, await prepare(kind, track));
      if (kind === "screen") track.addEventListener("ended", () => stopLocal("screen"), { once: true });
    } catch (error) {
      capture.release(kind);
      throw error;
    }
    capture.refreshDevices().catch(() => {});
  }

  /** Admit with a fresh ticket, publish the profile and start media. Resolves with the status. */
  async function admit() {
    await session.connect();
    if (state.status !== "admitted") return state.status;
    await enterMedia();
    return state.status;
  }

  /**
   * Rejoin as a new session after resume or media transports failed for good: leave the
   * old session, admit again, rebuild media and republish live capture with its mute state.
   */
  async function readmit() {
    if (leaving || readmitting) return;
    retryChoice = api.getRetryChoice();
    readmitting = true;
    dispatch({ type: "status", status: "reconnecting" });
    const live = [...local.entries()].map(([kind, producerId]) => ({ kind, paused: state.producers[producerId]?.paused === true }));
    for (const producerId of local.values()) dispatch({ type: "localProducerClosed", id: producerId });
    local.clear();
    media.close();
    await session.leave().catch(() => {});
    try {
      for (const delay of READMIT_DELAYS_MS) {
        await wait(retryDelay(delay, random));
        if (leaving) return;
        media = createMedia();
        try {
          if ((await admit()) !== "admitted") return;
          for (const { kind, paused } of live) {
            const track = outgoing(kind);
            if (track && track.readyState !== "ended") await publishLocal(kind, track, paused);
          }
          await refresh();
          retryChoice = null;
          return;
        } catch {
          media.close();
          await session.leave().catch(() => {});
        }
      }
      dispatch({ type: "status", status: "failed" });
    } finally {
      readmitting = false;
    }
  }

  /** Stop and unpublish one local source kind. */
  async function stopLocal(kind) {
    const producerId = local.get(kind);
    if (!producerId) return;
    local.delete(kind);
    dispatch({ type: "localProducerClosed", id: producerId });
    processors.get(kind)?.dispose();
    processors.delete(kind);
    capture.release(kind);
    await media.unpublish(producerId);
    if (kind === "camera") await session.command({ type: "videoOff" }).catch(() => {});
  }

  /** Re-acquire one live kind with current preferences and swap it into its producer. */
  async function recapture(kind) {
    const producerId = local.get(kind);
    const raw = await capture.acquire(kind);
    if (!raw) return;
    const track = producerId ? await prepare(kind, raw) : raw;
    if (producerId) await media.replaceTrack(producerId, track);
  }

  /**
   * Finish entering once admitted (directly, after a room password or after the lobby):
   * publish the prejoin choices and load the room. Runs once per admission.
   */
  function enterRoom() {
    entering ||= (async () => {
      await enterMedia();
      // Capture failures (denied permission, no device) still let the participant listen.
      if (choice.audio || capture.track("audio")) {
        try {
          await startLocal("audio");
          if (!choice.audio) await api.setMicrophoneMuted(true);
        } catch {
          capture.setStatus("", "microphone");
        }
      }
      if (choice.video) await startLocal("camera").catch(() => capture.setStatus("", "camera"));
      else capture.release("camera");
      await refresh();
    })();
    return entering;
  }

  /** Publish the profile and start media for an admitted session. */
  async function enterMedia() {
    if (profile.name) await session.command({ type: "participantProfile", change: { type: "name", value: profile.name } });
    // A prejoin avatar file uploads once admitted (uploads need the session); later
    // readmissions reuse the uploaded path.
    if (profile.avatarFile) {
      try {
        profile = { ...profile, avatar: new URL(await api.uploadImage("avatar", profile.avatarFile)).pathname, avatarFile: null };
      } catch {
        profile = { ...profile, avatarFile: null };
      }
    }
    const avatarPath = profileAvatarPath(profile.avatar, location);
    if (avatarPath) await session.command({ type: "participantProfile", change: { type: "avatar", value: avatarPath } });
    await media.start();
  }

  /** A presenter admitted this participant from the lobby, or rejected it. */
  function lobbyDecision(value) {
    if (state.status !== "lobby" || !value) return;
    const ids = value.peers_id || (value.peer_id ? [value.peer_id] : []);
    if (ids.length && !ids.includes(state.selfId)) return;
    if (value.lobby_status === "accept") {
      dispatch({ type: "status", status: "admitted" });
      enterRoom().catch(() => dispatch({ type: "status", status: "failed" }));
    } else if (value.lobby_status === "reject") {
      dispatch({ type: "status", status: "rejected" });
    }
  }

  const api = {
    /** Current immutable client state. */
    getState: () => state,
    /** Subscribe to state changes; returns an unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Media registry read by participant card views. */
    registry,
    /** Capture owner: devices, preferences and live local tracks. */
    capture,
    /** Local layout: pinned card, grid visibility, peer volumes. */
    layout,
    /** Personal preferences: language, shortcuts, master speaker volume. */
    preferences,
    /** Latest profile and enabled microphone/camera choices, preserved before teardown. */
    getRetryChoice() {
      return retryChoice || joinChoiceForRetry(state, profile, choice, local);
    },
    /** Admit with a profile and initial capture choices; resolves with the final status. */
    async join({ name = "", avatar = "", avatarFile = null, audio = true, video = true } = {}) {
      retryChoice = null;
      profile = { name, avatar, avatarFile };
      choice = { audio, video };
      try {
        await session.connect();
      } catch (error) {
        dispatch({ type: "status", status: [404, 403].includes(error.status) ? "unavailable" : error.code === "denied" ? "denied" : "failed" });
        throw error;
      }
      if (state.status === "admitted") await enterRoom();
      return state.status;
    },
    /** Answer a password-protected room; resolves whether the password was accepted. */
    async submitPassword(password) {
      if (state.status !== "password" || typeof password !== "string" || !password) return false;
      const value = await session.command({ type: "roomControl", action: { type: "password", password } });
      if (!value?.accepted) return false;
      dispatch({ type: "status", status: "admitted" });
      await enterRoom();
      return true;
    },
    /** Start (or restart) a prejoin preview of one capture kind. */
    async preview(kind, enabled) {
      if (!enabled) return capture.release(kind);
      await capture.acquire(kind);
      capture.refreshDevices().catch(() => {});
    },
    /** Mute or unmute the published microphone. */
    async setMicrophoneMuted(muted) {
      const producerId = local.get("audio");
      if (!producerId) return;
      await media.setPaused(producerId, muted);
      dispatch({ type: "localProducer", id: producerId, kind: "audio", paused: muted });
    },
    /** Turn the camera on or off (off releases the capture). */
    setCameraEnabled: (enabled) => (enabled ? startLocal("camera") : stopLocal("camera")),
    /** Start or stop screen sharing; the browser's own stop also ends it. */
    setScreenSharing: (enabled) => (enabled ? startLocal("screen") : stopLocal("screen")),
    /**
     * Change one capture preference; live microphone/camera captures restart in place.
     * Output-device changes only update the snapshot read by audio elements.
     */
    async setCapturePreference(key, value) {
      const affected = capture.setPreference(key, value);
      if (affected === "background") {
        capture.setStatus(key);
        try {
          await reprocess("camera");
        } finally {
          capture.setStatus("", capture.getSnapshot().error);
        }
        return;
      }
      if (affected !== "audio" && affected !== "camera") return;
      capture.setStatus(key);
      try {
        await recapture(affected);
        capture.setStatus("");
      } catch (error) {
        capture.setStatus("", error.name || "capture");
        throw error;
      }
    },
    /** Send one raw protocol action (used by feature modules). */
    command: (action, timeout) => session.command(action, timeout),
    /** Observe raw Rust events (after state is updated); returns an unsubscribe function. */
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    /** Observe binary (file-transfer) frames; returns an unsubscribe function. */
    subscribeBinary(listener) {
      binaryListeners.add(listener);
      return () => binaryListeners.delete(listener);
    },
    /**
     * Upload one image for this session (`kind`: "chat" or "avatar"); resolves with the
     * absolute same-origin URL of the published file.
     */
    async uploadImage(kind, file, { signal } = {}) {
      const path = kind === "avatar" ? "/api/meeting/avatar" : "/api/meeting/chat-image";
      if (kind === "avatar") file = await normalizeAvatar(file);
      const response = await fetchImpl(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.ownerProof}`, "X-Meeting-Session-Id": session.sessionId, "Content-Type": file.type },
        body: file,
        signal,
      });
      if (!response.ok) throw Object.assign(new Error(`Upload rejected (${response.status})`), { status: response.status });
      const { url } = await response.json();
      const pattern = kind === "avatar" ? /^\/uploads\/avatars\/[0-9a-f-]+\.(png|jpg|webp)$/ : /^\/uploads\/chat\/[0-9a-f-]+\.(png|jpg|webp)$/;
      if (typeof url !== "string" || !pattern.test(url)) throw new Error("Invalid upload URL");
      return `${location.protocol}//${location.host}${url}`;
    },
    /** Upload a durable public attachment using this session's independent owner proof. */
    async uploadAttachment(file, { signal } = {}) {
      const response = await fetchImpl("/api/meeting/chat-attachments", {
        method: "POST", headers: { Authorization: `Bearer ${session.ownerProof}`, "X-Meeting-Session-Id": session.sessionId,
          "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-File-Size": String(file.size) }, body: file, signal,
      });
      if (!response.ok) throw new Error(`Attachment rejected (${response.status})`);
      return response.json();
    },
    /** Read durable bytes only through current same-room owner authorization. */
    async attachmentBlob(id, { signal } = {}) {
      const response = await fetchImpl(`/api/meeting/chat-attachments/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${session.ownerProof}`, "X-Meeting-Session-Id": session.sessionId }, signal,
      });
      if (!response.ok) throw new Error(`Attachment unavailable (${response.status})`);
      return response.blob();
    },
    /** Leave the meeting; `{ notify: false }` (page unload) lets a reload take the session over. */
    async leave(options) {
      retryChoice = api.getRetryChoice();
      leaving = true;
      // Close the session first so a server-side close (kick, ban, takeover) arriving
      // during the teardown below is not mistaken for a drop and resumed.
      const closing = session.leave(options);
      for (const handle of processors.values()) handle.dispose();
      processors.clear();
      capture.stopAll();
      local.clear();
      media.close();
      await closing;
      registryClosed = true;
      registry.dispose();
    },
    /** Session used by file transfer. */
    session,
  };
  // Mirror the language preference into state so every view reads one value.
  const syncLanguage = () => dispatch({ type: "language", language: preferences.getSnapshot().language });
  preferences.subscribe(syncLanguage);
  syncLanguage();
  return api;
}
