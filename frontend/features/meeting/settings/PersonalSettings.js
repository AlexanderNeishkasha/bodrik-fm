"use client";

import { useEffect, useSyncExternalStore } from "react";
import SelectControl from "../../../components/ui/SelectControl";
import { SettingRow, SettingSwitch } from "./SettingControls";
import styles from "./AudioSettings.module.css";
import layout from "./PersonalSettings.module.css";
import { t } from "../../../app/lang/index.js";

/** Localized presentation for the existing personal/layout commands, not another preference authority. */
/** Render local-only settings with shared primitives; no media or moderation command is executed on mount. */
export default function PersonalSettings({ source, kind, onReady }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = t("meeting.personalSettings");
  /** Let the command source publish rollback/error state without optimistic view copies. */
  async function change(key, value) {
    try { await source.execute(key, value); }
    catch { console.warn("Personal preference command rejected; see settings status"); }
  }
  return <section className={styles.section} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <header className={styles.header}><h3>{text[kind]}</h3></header>
    {kind === "shortcuts" && <><SettingRow label={text.enabled}><SettingSwitch label={text.enabled} checked={snapshot.shortcuts} disabled={!!snapshot.pending} onChange={(value) => change("shortcuts", value)} /></SettingRow><dl className={layout.shortcuts}>{["A", "V", "S", "C", "O"].map((key, index) => <div className={layout.shortcut} key={key}><dt><kbd>{key}</kbd></dt><dd>{text.actions[index]}</dd></div>)}</dl></>}
    {snapshot.error && <p role="alert">{text.error}</p>}
  </section>;
}
