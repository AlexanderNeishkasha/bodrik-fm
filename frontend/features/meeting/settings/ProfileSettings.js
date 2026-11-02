"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Button from "../../../components/ui/Button";
import Icon from "../../../components/ui/Icon";
import ParticipantAvatar from "../media/ParticipantAvatar";
import styles from "./AudioSettings.module.css";
import layout from "./ProfileSettings.module.css";
import { t } from "../../../app/lang/index.js";

/** Profile copy belongs to React; uploaded files and admission credentials stay outside the view state. */
/** Render a name draft, not a second profile store; the key resets only when the authoritative name changes. */
function NameForm({ name, disabled, text, submit }) {
  const [draft, setDraft] = useState(name);
  return <form className={layout.nameForm} onSubmit={(event) => { event.preventDefault(); submit(draft); }}>
    <label className={layout.nameLabel}><Icon name="profile" size={18} />{text.name}</label>
    <div className={layout.nameControls}>
      <input aria-label={text.name} value={draft} maxLength={32} disabled={disabled} onChange={(event) => setDraft(event.target.value)} />
      <Button type="submit" disabled={disabled || !draft.trim()}><Icon name="check" size={17} />{text.save}</Button>
    </div>
  </form>;
}

/** Project the single runtime identity source; mounting does not upload, persist or send peer events. */
export default function ProfileSettings({ source, onReady }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = t("meeting.profileSettings");
  const disabled = !!snapshot.pending || snapshot.available === false;
  useEffect(() => { onReady?.(); }, [onReady]);
  /** The source reports errors and rejects obsolete session results; the view owns only the name draft. */
  async function change(key, value) {
    try { await source.execute(key, value); }
    catch { console.warn("Profile command rejected; see profile settings status"); }
  }
  return <section className={`${styles.section} ${layout.profile}`}
    onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <header className={styles.header}><h3>{text.title}</h3><p>{text.intro}</p></header>
    <div className={layout.identity}>
      <span className={layout.avatar}><ParticipantAvatar participant={{ name: snapshot.name, avatar: snapshot.avatar }} /></span>
      <div className={layout.identityBody}>
        <p className={layout.displayName}>{snapshot.name}</p>
        <span className={layout.role}><Icon name={snapshot.presenter ? "moderator" : "profile"} size={14} />{snapshot.presenter ? text.presenter : text.participant}</span>
        <div className={layout.avatarActions}>
          <label className={layout.upload}><Icon name="image" size={18} />{text.upload}
            <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={text.upload} disabled={disabled} onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) change("avatar", file);
            }} />
          </label>
          {snapshot.customAvatar && <button type="button" className={layout.clearAvatar} aria-label={text.resetLabel} disabled={disabled} onClick={() => change("resetAvatar")}>{text.reset}</button>}
        </div>
      </div>
    </div>
    <div className={layout.card}>
      <NameForm key={snapshot.name} name={snapshot.name} disabled={disabled} text={text} submit={(name) => change("name", name)} />
    </div>
    {snapshot.details?.length > 0 && <details className={layout.technical}><summary>{text.details}</summary><dl className={layout.details}>
      {snapshot.details.map((row) => <div key={row.key}><dt>{text[row.key]}</dt><dd>{row.values.map((value) => <span key={value}>{value}</span>)}</dd></div>)}
    </dl></details>}
    {snapshot.error && <p role="alert" className={layout.error}>{text.error}</p>}
  </section>;
}
