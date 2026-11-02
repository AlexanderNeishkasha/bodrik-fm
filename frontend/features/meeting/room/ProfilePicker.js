"use client";

import { useId } from "react";
import { Plus, X } from "lucide-react";

import styles from "./MeetingPrejoin.module.css";

/** Initials for an avatar placeholder. */
export function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

/** Round avatar: the picture when there is one, otherwise the name's initials. */
export function AvatarCircle({ name, src, className = styles.avatar }) {
  return <span className={className} aria-hidden="true"
    style={src ? { backgroundImage: `url("${src}")` } : undefined}>
    {!src && initials(name)}
  </span>;
}

/**
 * Saved profiles as selectable tiles plus a "+" tile for a new identity.
 * `selected` is the chosen profile name, or null while the new-profile form is open.
 */
export default function ProfilePicker({ profiles, selected, text, onSelect, onAdd, onRemove }) {
  const labelId = useId();
  return <div className={styles.profilePicker}>
    <p className={styles.profilesLabel} id={labelId}>{text.profiles}</p>
    <div className={styles.profiles} role="group" aria-labelledby={labelId}>
      {profiles.map((profile) => <div className={styles.profile} key={profile.name}>
        <button type="button" className={styles.profileButton} aria-pressed={selected === profile.name}
          onClick={() => onSelect(profile.name)}>
          <AvatarCircle name={profile.name} src={profile.avatar} className={styles.profileAvatar} />
          <span className={styles.profileName}>{profile.name}</span>
        </button>
        <button type="button" className={styles.profileRemove} aria-label={`${text.removeProfile}: ${profile.name}`}
          title={text.removeProfile} onClick={() => onRemove(profile.name)}><X size={14} aria-hidden="true" /></button>
      </div>)}
      <div className={styles.profile}>
        <button type="button" className={styles.profileButton} aria-pressed={selected === null} onClick={onAdd}>
          <span className={`${styles.profileAvatar} ${styles.profileAdd}`} aria-hidden="true"><Plus size={24} /></span>
          <span className={styles.profileName}>{text.newProfile}</span>
        </button>
      </div>
    </div>
  </div>;
}
