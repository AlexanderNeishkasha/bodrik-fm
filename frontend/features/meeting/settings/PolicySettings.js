"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Button from "../../../components/ui/Button";
import { SettingRow, SettingSwitch } from "./SettingControls";
import styles from "./AudioSettings.module.css";
import form from "./ProfileSettings.module.css";

/** Policy copy is UI-owned; success and current booleans always originate from the authorized server. */
const copy = {
  ru: { room: "Доступ к комнате", moderator: "Разрешения участников", lobby: "Зал ожидания", joinLock: "Закрыть вход новым участникам", password: "Пароль комнаты", lock: "Установить пароль", unlock: "Удалить пароль", passwordPlaceholder: "Новый пароль", locked: "Пароль установлен", presenter: "Изменять эти настройки может только ведущий.", error: "Сервер не подтвердил изменение настройки.", unknown: "Результат неизвестен. Проверьте состояние комнаты перед повторной попыткой.", storage: "Настройка применена сервером, но локальное сохранение не удалось.", audio_start_muted: "Микрофоны выключены при входе", video_start_hidden: "Камеры выключены при входе", audio_cant_unmute: "Запретить включать микрофон", video_cant_unhide: "Запретить включать камеру", screen_cant_share: "Запретить демонстрацию экрана", chat_cant_privately: "Запретить личные сообщения", chat_cant_publicly: "Запретить сообщения в общем чате", bans: "Забаненные участники", bansEmpty: "Никто не забанен.", unban: "Разбанить", hoursLeft: "ещё {n} ч", minutesLeft: "ещё {n} мин", bansNote: "Бан действует 24 часа и сбрасывается при перезапуске сервера." },
  en: { room: "Room access", moderator: "Participant permissions", lobby: "Waiting room", joinLock: "Lock room for new participants", password: "Room password", lock: "Set password", unlock: "Remove password", passwordPlaceholder: "New password", locked: "Password is set", presenter: "Only the presenter can change these settings.", error: "The server did not confirm the policy change.", unknown: "The outcome is unknown. Check room state before trying again.", storage: "The server applied the policy, but local persistence failed.", audio_start_muted: "Participants start muted", video_start_hidden: "Participants start with camera off", audio_cant_unmute: "Prevent microphone activation", video_cant_unhide: "Prevent camera activation", screen_cant_share: "Prevent screen sharing", chat_cant_privately: "Prevent private messages", chat_cant_publicly: "Prevent public messages", bans: "Banned participants", bansEmpty: "Nobody is banned.", unban: "Unban", hoursLeft: "{n} h left", minutesLeft: "{n} min left", bansNote: "Bans last 24 hours and reset when the server restarts." },
};

/** Password is a temporary masked UI draft, never stored in a policy snapshot or local preferences. */
function PasswordForm({ disabled, text, submit }) {
  const [password, setPassword] = useState("");
  return <form onSubmit={async (event) => {
    event.preventDefault();
    if (await submit(password)) setPassword("");
  }}>
    <SettingRow label={text.password} />
    <div className={form.nameControls}>
      <input type="password" autoComplete="new-password" aria-label={text.password} placeholder={text.passwordPlaceholder} maxLength={256} value={password} disabled={disabled} onChange={(event) => setPassword(event.target.value)} />
      <Button type="submit" variant="accent" disabled={disabled || !password.trim()}>{text.lock}</Button>
    </div>
  </form>;
}

/** Remaining ban time as hours, or minutes under an hour. */
function remaining(seconds, text) {
  return seconds >= 3600 ? text.hoursLeft.replace("{n}", Math.floor(seconds / 3600)) : text.minutesLeft.replace("{n}", Math.max(1, Math.ceil(seconds / 60)));
}

/** Presenter ban list with per-row unban; loaded when the moderator tab opens. */
function BanList({ bans, disabled, text, change }) {
  return <div className={`${form.card} ${styles.infoCard}`}>
    <h4>{text.bans}</h4>
    {bans?.length ? <ul className={form.bans}>
      {bans.map((row) => <li key={row.id}>
        <span><strong>{row.name || "—"}</strong> <small>{remaining(row.expiresIn, text)}</small></span>
        <Button disabled={disabled} onClick={() => change("unban", row.id)}>{text.unban}</Button>
      </li>)}
    </ul> : <p>{text.bansEmpty}</p>}
    <p><small>{text.bansNote}</small></p>
  </div>;
}

/** Render one policy section; no optimistic flag copying and no media side effects during render. */
export default function PolicySettings({ source, kind, onReady }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = copy[snapshot.language === "en" ? "en" : "ru"];
  const config = snapshot.state.config;
  const caps = snapshot.capabilities;
  useEffect(() => { onReady?.(); }, [onReady]);
  // The settings client reloads the list whenever the moderator tab is shown.
  const showBans = kind === "moderator" && caps.presenter && snapshot.available;
  const disabled = !!snapshot.pending || !snapshot.available || !caps.presenter;
  /** Return true only for an acknowledged operation; errors stay in the source's bounded public status. */
  async function change(key, value) {
    try { await source.execute(key, value); return true; }
    catch { console.warn("Policy command not confirmed; see policy status"); return false; }
  }
  /** Controlled switches read server booleans directly, rather than keeping UI-owned policy values. */
  function toggle(key, checked, capability = true) {
    return <SettingRow key={key} label={text[key]}><SettingSwitch label={text[key]} checked={checked} disabled={disabled || !capability} onChange={(value) => change(key, value)} /></SettingRow>;
  }
  // Room access and moderation are presenter-only: hidden for others.
  if (!caps.presenter) return null;
  return <section className={styles.section} lang={snapshot.language} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <header className={styles.header}><h3>{text[kind]}</h3></header>
    {kind === "room" && <>
      {caps.joinLock && toggle("joinLock", config.isJoinLocked)}
      {caps.lobby && toggle("lobby", config.isLobbyEnabled)}
      {caps.password && (config.isLocked ? <><p>{text.locked}</p><Button disabled={disabled} onClick={() => change("unlock")}>{text.unlock}</Button></> :
        <PasswordForm disabled={disabled} text={text} submit={(value) => change("password", value)} />)}
    </>}
    {kind === "moderator" && Object.entries(snapshot.state.moderator).filter(([key]) => key !== "video_start_privacy").map(([key, value]) => toggle(key, value, caps.moderator))}
    {showBans && <BanList bans={snapshot.bans} disabled={disabled} text={text} change={change} />}
    {snapshot.error && <p role="alert">{snapshot.error === "unknown_outcome" ? text.unknown : snapshot.error === "storage" ? text.storage : text.error}</p>}
  </section>;
}
