"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { Mic, MicOff, Monitor, MonitorOff, MoreVertical, Search, ShieldCheck, UserPlus, UserX, Video, VideoOff } from "lucide-react";
import Button from "../../../components/ui/Button";
import RangeControl from "../../../components/ui/RangeControl";
import styles from "./ParticipantsPanel.module.css";

/** Participant copy is UI-owned; observed server role/status never grants action permissions in this renderer. */
const copy = {
  ru: {
    title: "Участники", refresh: "Обновить", empty: "Нет участников", waiting: "Зал ожидания",
    presenter: "Ведущий", guest: "Участник", music: "Музыка от чародея", audio: "Микрофон включён",
    muted: "Микрофон выключен", video: "Камера включена", screen: "Демонстрация экрана",
    error: "Не удалось подтвердить список участников.", unavailable: "Нет активной сессии встречи.",
    actionError: "Действие отклонено или не подтверждено.", search: "Поиск участников",
    privateChat: "Личный чат", roleGrant: "Назначить ведущим", roleRevoke: "Снять роль ведущего", mute: "Выключить микрофон",
    hide: "Выключить камеру", stop: "Остановить демонстрацию", ban: "Забанить на 24 часа", eject: "Выгнать",
    pin: "В фокус", hideGrid: "Скрыть из сетки", showGrid: "Показать в сетке", accept: "Принять", reject: "Отклонить",
    acceptAll: "Принять всех", rejectAll: "Отклонить всех", volume: "Громкость", actions: "Действия", invite: "Пригласить", roomActions: "Действия комнаты", muteAll: "Выключить микрофоны у всех", hideAll: "Выключить камеры у всех", stopAll: "Остановить все демонстрации", disconnectAll: "Отключить всех участников", you: "вы", videoOff: "Камера выключена", screenOff: "Нет демонстрации экрана",
  },
  en: {
    title: "Participants", refresh: "Refresh", empty: "No participants", waiting: "Waiting room",
    presenter: "Presenter", guest: "Participant", music: "Music from the sorcerer", audio: "Microphone on",
    muted: "Microphone off", video: "Camera on", screen: "Sharing screen",
    error: "The participant list could not be verified.", unavailable: "No active meeting session.",
    actionError: "The action was rejected or could not be confirmed.", search: "Search participants",
    privateChat: "Private chat", roleGrant: "Make presenter", roleRevoke: "Remove presenter role", mute: "Mute microphone",
    hide: "Turn camera off", stop: "Stop screen sharing", ban: "Ban for 24 hours", eject: "Kick",
    pin: "Focus", hideGrid: "Hide from grid", showGrid: "Show in grid", accept: "Admit", reject: "Reject",
    acceptAll: "Admit all", rejectAll: "Reject all", volume: "Volume", actions: "Actions", invite: "Invite", roomActions: "Room actions", muteAll: "Mute everyone", hideAll: "Turn off every camera", stopAll: "Stop all screen sharing", disconnectAll: "Disconnect all participants", you: "you", videoOff: "Camera off", screenOff: "Not sharing screen",
  },
};

/** Render initials when an allowlisted uploaded avatar is unavailable. */
function Avatar({ participant }) {
  const initials = participant.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return participant.avatar
    ? <Image unoptimized width={40} height={40} loading="eager" className={styles.avatar} src={participant.avatar} alt="" referrerPolicy="no-referrer" />
    : <span className={styles.avatarFallback} aria-hidden="true">{initials || "?"}</span>;
}

/** Render one explicit action and keep native authorization/failure behavior visible. */
function Action({ children, disabled, onClick, danger = false }) {
  return <Button className={danger ? styles.danger : undefined} disabled={disabled} onClick={onClick}>{children}</Button>;
}

/** Render safe participant/lobby observations and delegate commands to the caller-owned runtime. */
export default function ParticipantsPanel({ source, onReady, headerControl }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = copy[snapshot.language === "en" ? "en" : "ru"];
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState("");
  const membershipKey = snapshot.peers.map((peer) => peer.id).sort().join(",");
  const [previousMembership, setPreviousMembership] = useState(membershipKey);
  if (membershipKey !== previousMembership) {
    setPreviousMembership(membershipKey);
    setOpenMenu("");
  }
  useEffect(() => { onReady?.(); }, [onReady]);
  const peers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(snapshot.language);
    return needle ? snapshot.peers.filter((peer) => peer.name.toLocaleLowerCase(snapshot.language).includes(needle)) : snapshot.peers;
  }, [query, snapshot.language, snapshot.peers]);
  const busy = snapshot.pending || Boolean(snapshot.pendingCommand);

  /** Run one command without leaking credentials or turning rejection into success. */
  async function act(value) {
    try { await source.execute(value); }
    catch (failure) { if (failure.name !== "AbortError") console.warn("Participant action unavailable; see panel status"); }
  }
  /** Open one row or room menu at a time. */
  function toggleMenu(id) { setOpenMenu((current) => (current === id ? "" : id)); }
  /** Close the menu and run a moderation command (a ban is confirmed by the room dialog). */
  function ask(command) { setOpenMenu(""); act(command); }

  return <section className={styles.panel} lang={snapshot.language} aria-busy={busy}>
    <header className={styles.header}>
      <h2 className={styles.srOnly}>{text.title}</h2>
      <button type="button" className={styles.invite} disabled={!snapshot.available || busy} onClick={() => act({ type: "invite" })}>
        <UserPlus size={16} aria-hidden="true" /> {text.invite}</button>
      {snapshot.presenter && <div className={styles.menuAnchor}>
        <button type="button" className={styles.iconButton} aria-label={text.roomActions} title={text.roomActions} aria-haspopup="menu"
          aria-expanded={openMenu === "room"} onClick={() => toggleMenu("room")}><ShieldCheck size={18} /></button>
        {openMenu === "room" && <div className={styles.menu} role="menu" aria-label={text.roomActions}>
          <button type="button" role="menuitem" disabled={busy} onClick={() => ask({ type: "moderateAll", action: "mute" })}><MicOff size={16} /> {text.muteAll}</button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => ask({ type: "moderateAll", action: "hide" })}><VideoOff size={16} /> {text.hideAll}</button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => ask({ type: "moderateAll", action: "stop" })}><MonitorOff size={16} /> {text.stopAll}</button>
          <button type="button" role="menuitem" className={styles.dangerText} disabled={busy} onClick={() => ask({ type: "moderateAll", action: "eject" })}><UserX size={16} /> {text.disconnectAll}</button>
        </div>}
      </div>}
      <div className={styles.headerControl}>{headerControl}</div>
    </header>
    <div className={styles.scrollBody}>
    <label className={styles.search}>
      <Search size={18} aria-hidden="true" />
      <input aria-label={text.search} placeholder={text.search} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={256} />
    </label>
    {!snapshot.available && <p>{text.unavailable}</p>}
    {snapshot.error && <p role="alert">{text.error}</p>}
    {snapshot.actionError && <p role="alert">{text.actionError}</p>}

    {snapshot.presenter && snapshot.lobby.length > 0 && <section className={styles.lobby} aria-labelledby="meeting-lobby-title">
      <header><h3 id="meeting-lobby-title">{text.waiting} ({snapshot.lobby.length})</h3>
        <div className={styles.inlineActions}>
          <Action disabled={busy} onClick={() => act({ type: "lobby", targetId: "all", accepted: true })}>{text.acceptAll}</Action>
          <Action danger disabled={busy} onClick={() => act({ type: "lobby", targetId: "all", accepted: false })}>{text.rejectAll}</Action>
        </div>
      </header>
      <ul className={styles.list}>{snapshot.lobby.map((peer) => <li key={peer.id} className={styles.participant}>
        <div className={styles.identity}><Avatar participant={peer} /><strong>{peer.name}</strong></div>
        <div className={styles.inlineActions}>
          <Action disabled={busy} onClick={() => act({ type: "lobby", targetId: peer.id, accepted: true })}>{text.accept}</Action>
          <Action danger disabled={busy} onClick={() => act({ type: "lobby", targetId: peer.id, accepted: false })}>{text.reject}</Action>
        </div>
      </li>)}</ul>
    </section>}

    <p className={styles.count}>{text.title}: {snapshot.peers.filter((peer) => !peer.bot).length}</p>
    <ul className={styles.list}>
      {snapshot.available && !snapshot.pending && !snapshot.error && !peers.length && <li><p>{text.empty}</p></li>}
      {peers.map((peer) => {
        const self = peer.id === snapshot.selfId;
        const canModerate = snapshot.presenter && !self && !peer.bot;
        const isHidden = snapshot.hidden.includes(peer.id);
        const menuOpen = openMenu === peer.id;
        return <li key={peer.id} className={styles.participant}>
          <div className={styles.row}>
            <div className={styles.identity}><Avatar participant={peer} /><div className={styles.identityText}>
              <strong className={styles.name}>{peer.name}{self ? ` (${text.you})` : ""}</strong>
              <span className={styles.subtle}>{peer.bot ? text.music : peer.presenter ? text.presenter : text.guest}</span></div></div>
            {!self && <button type="button" className={styles.iconButton} aria-label={`${text.actions}: ${peer.name}`} title={text.actions}
              aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => toggleMenu(peer.id)}><MoreVertical size={18} /></button>}
          </div>
          {!peer.bot && <div className={styles.status}>
            <span role="img" className={peer.audio ? styles.on : styles.off} aria-label={peer.audio ? text.audio : text.muted}>{peer.audio ? <Mic size={16} /> : <MicOff size={16} />}</span>
            <span role="img" className={peer.video ? styles.on : styles.off} aria-label={peer.video ? text.video : text.videoOff}>{peer.video ? <Video size={16} /> : <VideoOff size={16} />}</span>
            <span role="img" className={peer.screen ? styles.on : styles.off} aria-label={peer.screen ? text.screen : text.screenOff}>{peer.screen ? <Monitor size={16} /> : <MonitorOff size={16} />}</span>
          </div>}
          {menuOpen && <div className={styles.rowMenu} role="menu" aria-label={`${text.actions}: ${peer.name}`}>
            <RangeControl label={text.volume} value={snapshot.volumes[peer.id] ?? peer.volume} min={0} max={100} step={1}
              disabled={busy}
              onInput={(event) => act({ type: "volume", targetId: peer.id, value: Number(event.currentTarget.value) })} />
            {!peer.bot && <button type="button" role="menuitem" disabled={busy} onClick={() => act({ type: "chat", targetId: peer.id })}>{text.privateChat}</button>}
            {!peer.bot && <button type="button" role="menuitem" disabled={busy} onClick={() => act({ type: "pin", targetId: peer.id })}>{text.pin}</button>}
            <button type="button" role="menuitem" disabled={busy} onClick={() => act({ type: "visibility", targetId: peer.id, hidden: !isHidden })}>{isHidden ? text.showGrid : text.hideGrid}</button>
            {canModerate && <>
              <hr />
              <button type="button" role="menuitem" disabled={busy} onClick={() => act({ type: "role", targetId: peer.id, presenter: !peer.presenter })}>{peer.presenter ? text.roleRevoke : text.roleGrant}</button>
              <button type="button" role="menuitem" disabled={busy} onClick={() => ask({ type: "moderate", targetId: peer.id, action: "mute" })}>{text.mute}</button>
              <button type="button" role="menuitem" disabled={busy} onClick={() => ask({ type: "moderate", targetId: peer.id, action: "hide" })}>{text.hide}</button>
              <button type="button" role="menuitem" disabled={busy} onClick={() => ask({ type: "moderate", targetId: peer.id, action: "stop" })}>{text.stop}</button>
              <button type="button" role="menuitem" className={styles.dangerText} disabled={busy} onClick={() => ask({ type: "moderate", targetId: peer.id, action: "ban" })}>{text.ban}</button>
              <button type="button" role="menuitem" className={styles.dangerText} disabled={busy} onClick={() => ask({ type: "moderate", targetId: peer.id, action: "eject" })}>{text.eject}</button>
            </>}
          </div>}
        </li>;
      })}
    </ul>
    </div>
  </section>;
}
