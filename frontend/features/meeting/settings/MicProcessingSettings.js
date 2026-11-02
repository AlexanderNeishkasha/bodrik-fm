"use client";

import { useEffect, useSyncExternalStore } from "react";
import { SettingRow, SettingSwitch } from "./SettingControls";
import styles from "./SettingsSection.module.css";
import Icon from "../../../components/ui/Icon";
import { t } from "../../../app/lang/index.js";

/** Localized processing copy is React-owned, outside the legacy DOM translator. */
/** Render shared processing controls from one external authority; the view never captures media. */
export default function MicProcessingSettings({ source, onReady }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = t("meeting.micProcessingSettings");
  /** The service publishes failure status; rejection is handled here without duplicating that state. */
  async function change(key, enabled) {
    try { await source.execute(key, enabled); }
    catch { console.warn("Microphone preference command rejected; see settings status"); }
  }
  /** Explain a browser-reported mismatch without pretending a rejected preference was saved. */
  function description(help, key, effectiveKey) {
    const effective = snapshot[effectiveKey];
    return typeof effective === "boolean" && effective !== snapshot[key]
      ? `${help} ${text.effective}${effective ? text.enabled : text.disabled}.` : help;
  }
  return <section onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }} className={styles.section} aria-label={text.section}>
    <SettingRow icon={<Icon name="headphones" size={18} />} helpLabel={text.help} label={text.echo} description={description(text.echoHelp, "echoCancellation", "effectiveEchoCancellation")}><SettingSwitch label={text.echo} checked={snapshot.echoCancellation === true} disabled={!!snapshot.pending} onChange={(enabled) => change("echoCancellation", enabled)} /></SettingRow>
    <SettingRow icon={<Icon name="audio-lines" size={18} />} helpLabel={text.help} label={text.gain} description={description(text.gainHelp, "autoGainControl", "effectiveAutoGainControl")}><SettingSwitch label={text.gain} checked={snapshot.autoGainControl === true} disabled={!!snapshot.pending} onChange={(enabled) => change("autoGainControl", enabled)} /></SettingRow>
    {snapshot.error && <p className={styles.status} role="alert">{text.error}</p>}
  </section>;
}
