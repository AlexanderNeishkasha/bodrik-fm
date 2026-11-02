"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Button from "../../../components/ui/Button";
import { SettingRow, SettingSwitch } from "./SettingControls";
import styles from "./AudioSettings.module.css";
import form from "./ProfileSettings.module.css";
import { t } from "../../../app/lang/index.js";

/** Policy copy is UI-owned; success and current booleans always originate from the authorized server. */
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
  const text = t("meeting.policySettings");
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
  return <section className={styles.section} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
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
