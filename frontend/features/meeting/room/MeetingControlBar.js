"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronUp, Info, MessageSquare, Mic, MicOff, Monitor, MonitorOff, PhoneOff, Settings, Share2, Users, Video, VideoOff } from "lucide-react";

import { useCaptureState, useMeetingState } from "../client/useMeetingState";
import CameraQuickMenu from "./CameraQuickMenu";
import MicQuickMenu from "./MicQuickMenu";

import { transitionPanel } from "./panelMotion.mjs";
import styles from "./MeetingControlBar.module.css";

/** RU/EN labels. */
const COPY = {
  ru: { accessDenied: "Доступ не предоставлен", mute: "Выключить микрофон", unmute: "Включить микрофон", micDevices: "Выбор микрофона и динамика", cameraOff: "Выключить камеру", cameraOn: "Включить камеру", cameraDevices: "Выбор камеры", screenOn: "Демонстрация экрана", screenOff: "Остановить демонстрацию", chat: "Чат", participants: "Участники", settings: "Настройки", more: "Дополнительно", invite: "Поделиться комнатой", about: "О программе", leave: "Покинуть встречу", microphone: "Микрофон", speaker: "Динамик", camera: "Камера" },
  en: { accessDenied: "Access not granted", mute: "Mute microphone", unmute: "Unmute microphone", micDevices: "Choose microphone and speaker", cameraOff: "Turn camera off", cameraOn: "Turn camera on", cameraDevices: "Choose camera", screenOn: "Share screen", screenOff: "Stop sharing", chat: "Chat", participants: "Participants", settings: "Settings", more: "More", invite: "Share room", about: "About", leave: "Leave meeting", microphone: "Microphone", speaker: "Speaker", camera: "Camera" },
};

/** Idle time before the bar fades when auto-hide is on. */
const IDLE_MS = 4000;

/** Physical key shortcuts (layout independent), matching the legacy meeting. */
const SHORTCUTS = Object.freeze({ KeyA: "audio", KeyV: "video", KeyS: "screen", KeyC: "chat", KeyO: "settings" });

/** Participant view modes offered by the view menu. */
const VIEWS = Object.freeze([["grid", "grid"], ["speaker-top", "speakerTop"], ["speaker-bottom", "speakerBottom"], ["speaker-left", "speakerLeft"], ["speaker-right", "speakerRight"]]);

/** Whether a key event targets text entry. */
function editable(event) {
  return event.composedPath().some((element) => element?.nodeType === 1 &&
    (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.getAttribute?.("role") === "textbox"));
}

/** Read a subscribable source (null-safe). */
function useSource(source, fallback) {
  return useSyncExternalStore(source ? source.subscribe : noop, source ? source.getSnapshot : () => fallback, () => fallback);
}

/** Subscription used without a source. */
function noop() {
  return () => {};
}

/** One popup menu anchored above its trigger; closes on outside click or Escape. */
function Menu({ label, open, onClose, bare = false, alignEnd = false, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!ref.current?.parentElement?.contains(event.target)) onClose();
    };
    const escape = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onClose]);
  if (!open) return null;
  if (bare) return <div ref={ref} className={styles.bareMenu}>{children}</div>;
  return <div ref={ref} style={{ viewTransitionName: "meeting-control-menu" }} className={`${styles.menu} ${alignEnd ? styles.menuEnd : ""}`} role="menu" aria-label={label}>{children}</div>;
}

/** Bottom meeting control bar for the headless client. */
export default function MeetingControlBar({ client, chat, participants, settings, onOpenSettings, onInvite, onAbout, onError, language = "ru", shortcuts = true, autoHide = false }) {
  const text = COPY[language === "en" ? "en" : "ru"];
  const state = useMeetingState(client);
  const capture = useCaptureState(client);
  const chatState = useSource(chat, null);
  const layout = useSource(client.layout, null);
  const [menu, setMenu] = useState("");
  const [idle, setIdle] = useState(false);

  // Mobile exposes device choices through settings; dispose open quick-menu resources on resize.
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 700px)");
    /** Close desktop quick menus when their mobile triggers disappear. */
    const closeForMobile = () => { if (mobile.matches) setMenu(""); };
    mobile.addEventListener("change", closeForMobile);
    return () => mobile.removeEventListener("change", closeForMobile);
  }, []);

  // "Keep controls visible" off: fade the bar after a few seconds without pointer or key activity.
  useEffect(() => {
    if (!autoHide) return undefined;
    let timer = setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
      setIdle(false);
    };
  }, [autoHide]);
  const own = Object.values(state.producers).filter((value) => value.participantId === state.selfId);
  const microphone = own.find((value) => value.kind === "audio");
  const camera = own.some((value) => value.kind === "camera");
  const screen = own.some((value) => value.kind === "screen");
  const humans = Object.values(state.participants).filter((value) => !value.bot).length;

  /** Report command failures, translating permission denial only for screen sharing. */
  function run(action, deniedMessage) {
    setMenu("");
    Promise.resolve().then(action).catch((error) => {
      onError?.(deniedMessage && error?.name === "NotAllowedError" ? new Error(deniedMessage, { cause: error }) : error);
    });
  }

  const actions = {
    audio: () => microphone && run(() => client.setMicrophoneMuted(!microphone.paused)),
    video: () => run(() => client.setCameraEnabled(!camera)),
    screen: () => capture.screenAvailable !== false && run(() => client.setScreenSharing(!screen), text.accessDenied),
    chat: () => transitionPanel(() => chat?.toggle()),
    settings: () => onOpenSettings?.(),
  };

  // Keyboard shortcuts work anywhere on the page except text entry.
  useEffect(() => {
    const keydown = (event) => {
      if (!shortcuts || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.defaultPrevented || editable(event)) return;
      const action = SHORTCUTS[event.code];
      if (!action) return;
      event.preventDefault();
      actions[action]();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  const toggle = (name) => setMenu((current) => (current === name ? "" : name));
  const closeMenu = () => setMenu("");
  const muted = !microphone || microphone.paused;

  return <nav style={{ viewTransitionName: "meeting-controls" }} className={`${styles.bar} ${idle && !menu ? styles.hidden : ""}`} aria-label={language === "en" ? "Meeting controls" : "Управление встречей"}>
    <div className={styles.split}>
      <button type="button" className={muted ? styles.off : undefined} disabled={!microphone} aria-pressed={!muted}
        aria-label={muted ? text.unmute : text.mute} title={muted ? text.unmute : text.mute} onClick={actions.audio}>
        {muted ? <MicOff size={24} /> : <Mic size={24} />}
      </button>
      <button type="button" className={styles.chevron} aria-haspopup="menu" aria-expanded={menu === "mic"} aria-label={text.micDevices} onClick={() => toggle("mic")}><ChevronUp size={16} /></button>
      <Menu label={text.micDevices} open={menu === "mic"} onClose={closeMenu} bare>
        <MicQuickMenu audio={settings.sources.audio} language={language} onError={onError}
          onOpenSettings={() => { closeMenu(); settings.openSection("tabAudioDevices"); }} />
      </Menu>
    </div>
    <div className={styles.split}>
      <button type="button" className={camera ? undefined : styles.off} aria-pressed={camera} aria-label={camera ? text.cameraOff : text.cameraOn}
        title={camera ? text.cameraOff : text.cameraOn} onClick={actions.video}>
        {camera ? <Video size={24} /> : <VideoOff size={24} />}
      </button>
      <button type="button" className={styles.chevron} aria-haspopup="menu" aria-expanded={menu === "camera"} aria-label={text.cameraDevices} onClick={() => toggle("camera")}><ChevronUp size={16} /></button>
      <Menu label={text.cameraDevices} open={menu === "camera"} onClose={closeMenu} bare>
        <CameraQuickMenu video={settings.sources.video} language={language} onError={onError}
          onOpenSettings={() => { closeMenu(); settings.openSection("tabVideoDevices"); }} />
      </Menu>
    </div>
    {capture.screenAvailable !== false && <button type="button" aria-pressed={screen} aria-label={screen ? text.screenOff : text.screenOn}
      title={screen ? text.screenOff : text.screenOn} className={screen ? styles.active : undefined} onClick={actions.screen}>
      {screen ? <MonitorOff size={24} /> : <Monitor size={24} />}
    </button>}
    <button type="button" aria-pressed={chatState?.visible === true} aria-label={text.chat} title={text.chat} onClick={actions.chat}>
      <MessageSquare size={24} />
      {chatState?.unread > 0 && <span className={styles.badge}>{chatState.unread}</span>}
    </button>
    <button type="button" aria-label={text.participants} title={text.participants} onClick={() => transitionPanel(() => participants?.toggle())}>
      <Users size={24} />
      {humans > 1 && <span className={styles.badge}>{humans}</span>}
    </button>
    <div className={styles.split}>
      <button type="button" aria-label={text.settings} title={text.settings} onClick={actions.settings}><Settings size={24} /></button>
      <button type="button" className={styles.chevron} aria-haspopup="menu" aria-expanded={menu === "more"} aria-label={text.more} onClick={() => toggle("more")}><ChevronUp size={16} /></button>
      <Menu label={text.more} open={menu === "more"} onClose={closeMenu} alignEnd>
        <button type="button" role="menuitem" className={styles.menuItem} onClick={() => run(() => onInvite?.())}><Share2 size={18} /> {text.invite}</button>
        <button type="button" role="menuitem" className={styles.menuItem} onClick={() => run(() => onAbout?.())}><Info size={18} /> {text.about}</button>
      </Menu>
    </div>
    <button type="button" className={styles.exit} aria-label={text.leave} title={text.leave} onClick={() => run(() => client.leave())}><PhoneOff size={24} /></button>
  </nav>;
}
