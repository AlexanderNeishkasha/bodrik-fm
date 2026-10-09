"use client";

import { useEffect, useSyncExternalStore } from "react";
import SelectControl from "../../../components/ui/SelectControl";
import { SettingRow, SettingSwitch } from "./SettingControls";
import styles from "./AudioSettings.module.css";
import layout from "./PersonalSettings.module.css";

/** Localized presentation for the existing personal/layout commands, not another preference authority. */
const copy = {
  ru: { layout: "Вид комнаты", shortcuts: "Горячие клавиши", language: "Язык", enabled: "Горячие клавиши", participantView: "Вид участников", pinPosition: "Положение закреплённого видео", buttonsBar: "Панель управления", aspectRatio: "Соотношение сторон", objectFit: "Масштабирование видео", videoControls: "Элементы управления видео", error: "Не удалось изменить настройку. Попробуйте ещё раз.", actions: ["Микрофон", "Камера", "Демонстрация экрана", "Чат", "Настройки"] },
  en: { layout: "Video layout", shortcuts: "Keyboard shortcuts", language: "Language", enabled: "Keyboard shortcuts", participantView: "Participant view", pinPosition: "Pinned video position", buttonsBar: "Buttons bar", aspectRatio: "Aspect ratio", objectFit: "Video cropping", videoControls: "Video controls", error: "Could not update the setting. Please try again.", actions: ["Microphone", "Camera", "Screen share", "Chat", "Settings"] },
};

/** Render local-only settings with shared primitives; no media or moderation command is executed on mount. */
export default function PersonalSettings({ source, kind, onReady }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = copy[snapshot.language === "en" ? "en" : "ru"];
  /** Let the command source publish rollback/error state without optimistic view copies. */
  async function change(key, value) {
    try { await source.execute(key, value); }
    catch { console.warn("Personal preference command rejected; see settings status"); }
  }
  return <section className={styles.section} lang={snapshot.language} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <header className={styles.header}><h3>{text[kind]}</h3></header>
    {kind === "shortcuts" && <><SettingRow label={text.enabled}><SettingSwitch label={text.enabled} checked={snapshot.shortcuts} disabled={!!snapshot.pending} onChange={(value) => change("shortcuts", value)} /></SettingRow><dl className={layout.shortcuts}>{["A", "V", "S", "C", "O"].map((key, index) => <div className={layout.shortcut} key={key}><dt><kbd>{key}</kbd></dt><dd>{text.actions[index]}</dd></div>)}</dl></>}
    {kind === "language" && <><SettingRow label={text.language} /><SelectControl label={text.language} options={[{ value: "ru", label: "Русский" }, { value: "en", label: "English" }]} value={snapshot.language} disabled={!!snapshot.pending} onChange={(event) => change("language", event.target.value)} /></>}
    {snapshot.error && <p role="alert">{text.error}</p>}
  </section>;
}
