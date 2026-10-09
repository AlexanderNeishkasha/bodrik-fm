"use client";

import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import AboutDialog from "../about/AboutDialog";
import MeetingNotifications from "../MeetingNotifications";

import ChatPanel from "../chat/ChatPanel";
import MeetingAudio from "../media/MeetingAudio";
import ParticipantsDock from "../participants/ParticipantsDock";
import SettingsWorkspace from "../settings/SettingsWorkspace";
import { useCaptureState, useMeetingState } from "../client/useMeetingState";
import MeetingControlBar from "./MeetingControlBar";
import MeetingGrid from "./MeetingGrid";
import ConfirmDialog from "./ConfirmDialog";
import ShareDialog from "./ShareDialog";
import styles from "./MeetingRoom.module.css";

/** Status lines shown over the grid when the meeting is not simply running. */
const STATUS = {
  ru: { reconnecting: "Переподключение…", failed: "Не удалось восстановить соединение.", left: "Вы покинули встречу.", kicked: "Ведущий выгнал вас из встречи.", banned: "Вас забанили в этой комнате.", lobby: "Ожидание в зале ожидания…" },
  en: { reconnecting: "Reconnecting…", failed: "Could not restore the connection.", left: "You left the meeting.", kicked: "The presenter kicked you from the meeting.", banned: "You were banned from this room.", lobby: "Waiting in the lobby…" },
};

/** Callback for views that report readiness; the room needs no handoff. */
function ready() {}

/** Running meeting: themed room, grid, audio, panels and the control bar. */
export default function MeetingRoom({ session, origin }) {
  const { client, chat, participants, settings, notifications } = session;
  const state = useMeetingState(client);
  const capture = useCaptureState(client);
  const preferences = useSyncExternalStore(client.preferences.subscribe, client.preferences.getSnapshot, client.preferences.getSnapshot);
  const [error, setError] = useState("");
  const [about, setAbout] = useState(null);
  const [share, setShare] = useState(false);
  const [sharedOnJoin, setSharedOnJoin] = useState(false);

  // Settings (Room tab) can ask for the share dialog.
  useEffect(() => session.subscribeShare(() => setShare(true)), [session]);

  // "Room link on join": show the share dialog once after admission.
  if (state.status === "admitted" && !sharedOnJoin) {
    setSharedOnJoin(true);
    if (preferences.shareOnJoin) setShare(true);
  }

  // "Keep screen awake": hold a screen wake lock while in the meeting; reacquire when visible.
  useEffect(() => {
    if (!preferences.keepAwake || typeof navigator.wakeLock?.request !== "function") return undefined;
    let lock = null;
    let stopped = false;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock.request("screen").then((value) => {
        if (stopped) return value.release();
        lock = value;
        session.wake.active = true;
        value.addEventListener("release", () => { session.wake.active = false; });
        return undefined;
      }).catch(() => { session.wake.active = false; });
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", acquire);
      lock?.release().catch(() => {});
      session.wake.active = false;
    };
  }, [preferences.keepAwake, session]);
  const chatOpen = useSyncExternalStore(chat.subscribe, () => chat.getSnapshot().visible, () => false);
  const dockOpen = useSyncExternalStore(participants.subscribe, () => participants.getSnapshot().visible, () => false);
  const panelOpen = chatOpen || dockOpen;
  const language = state.language === "en" ? "en" : "ru";
  const status = STATUS[language][state.status];

  /** Close the topmost panel; returns whether one was open. */
  function closeTopPanel() {
    if (chatOpen) chat.close();
    else if (dockOpen) participants.execute({ type: "close" }).catch(() => {});
    else return false;
    return true;
  }

  // Escape closes the topmost panel (dialogs handle their own Escape).
  useEffect(() => {
    const keydown = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (closeTopPanel()) event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  // Mobile Back closes an open panel instead of leaving the meeting.
  const onBack = useEffectEvent(() => closeTopPanel());
  useEffect(() => {
    if (!panelOpen) return undefined;
    window.history.pushState({ meetingPanel: true }, "");
    window.addEventListener("popstate", onBack);
    return () => {
      window.removeEventListener("popstate", onBack);
      if (window.history.state?.meetingPanel) window.history.back();
    };
  }, [panelOpen]);

  // Clear a stale error banner after a while.
  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  // Docked panels take room from the grid: chat at the right edge, participants beside it.
  const panelStyle = {
    "--meeting-chat-width": "min(460px, calc(100vw - 16px))",
    "--meeting-dock-width": "min(380px, calc(100vw - 16px))",
    "--meeting-chat-offset": chatOpen ? "calc(min(460px, calc(100vw - 16px)) + 8px)" : "0px",
    "--meeting-panels-width": `calc(${chatOpen ? "min(460px, calc(100vw - 16px)) + 8px" : "0px"} + ${dockOpen ? "min(380px, calc(100vw - 16px)) + 8px" : "0px"})`,
  };

  // Panel slide transitions are drawn on <html>; give them the chat offset there too.
  const chatOffset = panelStyle["--meeting-chat-offset"];
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--meeting-chat-offset", chatOffset);
    return () => root.style.removeProperty("--meeting-chat-offset");
  }, [chatOffset]);

  return <main className={styles.room} style={panelStyle} data-meeting-status={state.status}>
    <MeetingGrid registry={client.registry} layout={client.layout} participants={participants} selfId={state.selfId} presenter={state.presenter} language={language}
      hideCameraOff={!preferences.cameraOffParticipants} loaded={state.loaded} />
    <MeetingAudio registry={client.registry} outputDevice={capture.outputDevice} layout={client.layout} masterVolume={preferences.masterVolume} musicVolume={state.musicVolume} />
    {status && <p className={styles.status} role="status">{status}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <ChatPanel source={chat} origin={origin} />
    <ParticipantsDock source={participants} />
    <SettingsWorkspace source={settings.shell} sources={settings.sources} />
    <MeetingNotifications source={notifications} onReady={ready} />
    {share && <ShareDialog url={`${origin}/room/${encodeURIComponent(session.slug)}`} language={language} onClose={() => setShare(false)} />}
    {about && <AboutDialog snapshot={about} onClose={() => setAbout(null)} />}
    <ConfirmDialog confirmations={session.confirmations} language={language} />
    <MeetingControlBar client={client} chat={chat} participants={participants} settings={settings} language={language} shortcuts={preferences.shortcuts}
      autoHide={!preferences.keepControls}
      onOpenSettings={() => settings.open()}
      onInvite={() => setShare(true)} onAbout={() => setAbout({ language })} onError={(failure) => setError(failure?.message || String(failure))} />
  </main>;
}
