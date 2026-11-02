"use client";

import { useEffect, useSyncExternalStore } from "react";
import { SettingRow, SettingSlider } from "./SettingControls";
import styles from "./SettingsSection.module.css";
import Icon from "../../../components/ui/Icon";
import { t } from "../../../app/lang/index.js";

/** React-owned output copy; volume is local to this listener, not the Studio master. */
/** Render output gain from the existing room runtime; the view never creates an audio graph. */
export default function SpeakerVolumeSettings({ source, onReady }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = t("meeting.speakerVolumeSettings");
  /** Keep failures in the authoritative source, without optimistic duplicate slider state. */
  function change(value, persist) {
    try { source.setVolume(value, persist); }
    catch { console.warn("Output volume command rejected; see settings status"); }
  }
  const icon = <Icon name="volume" size={18} />;
  return <section className={`${styles.section} ${styles.output}`} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <SettingRow label={text.label} description={text.description} helpLabel={text.help} icon={icon} />
    <SettingSlider label={text.label} value={snapshot.speakerVolume} suffix="%" disabled={!snapshot.volumeAvailable} onPreview={(value) => change(value, false)} onCommit={(value) => change(value, true)} />
    {snapshot.volumeError && <p className={styles.status} role="alert">{text.error}</p>}
  </section>;
}
