"use client";

import { useEffect, useSyncExternalStore } from "react";
import { SettingRow } from "./SettingControls";
import Icon from "../../../components/ui/Icon";
import SelectControl from "../../../components/ui/SelectControl";
import Button from "../../../components/ui/Button";
import { effectLabels } from "../media/cameraEffects.mjs";
import styles from "./AudioSettings.module.css";

/** React-owned labels; device option names remain supplied by the native registry. */
const copy = {
  ru: { title: "Видео", intro: "Выберите камеру и настройте качество изображения.", camera: "Камера", quality: "Качество видео", fps: "FPS камеры", screenQuality: "Качество экрана", screenFps: "FPS экрана", screenHint: "Оптимизация экрана", empty: "Камеры не найдены", access: "Запросить доступ к камере", error: "Не удалось применить настройки видео. Проверьте доступ к камере или уменьшите качество." },
  en: { title: "Video", intro: "Choose your camera and balance image quality with performance.", camera: "Camera", quality: "Video quality", fps: "Camera FPS", screenQuality: "Screen quality", screenFps: "Screen FPS", screenHint: "Screen optimization", empty: "No cameras found", access: "Request camera access", error: "Could not apply video settings. Check camera access or lower the quality." },
};

/** Render camera (device, background effect, quality) and screen controls without creating capture. */
export default function VideoSettings({ source, onReady }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = copy[snapshot.language === "en" ? "en" : "ru"];
  const effects = effectLabels(snapshot.language);
  /** Runtime commands retain desired preferences and publish operation failures instead of optimistic view state. */
  async function change(key, value) {
    try { await source.execute(key, value); }
    catch { console.warn("Video settings command rejected; see video settings status"); }
  }
  return <section className={styles.section} lang={snapshot.language} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <header className={styles.header}><h3>{text.title}</h3><p>{text.intro}</p></header>
    <SettingRow label={text.camera} icon={<Icon name="video" size={18} />} />
    <SelectControl label={text.camera} options={snapshot.cameras} placeholder={text.empty} value={snapshot.camera} disabled={!!snapshot.pending || !snapshot.cameraAllowed || !snapshot.cameras.length} onChange={(event) => change("camera", event.target.value)} />
    {(!snapshot.cameras.length || snapshot.accessStatus) && <div><p role="status">{snapshot.accessStatus || text.empty}</p><Button disabled={!!snapshot.pending || snapshot.accessPending || !snapshot.cameraAllowed} onClick={() => change("requestAccess")}>{text.access}</Button></div>}
    <SettingRow label={effects.title} icon={<Icon name="image" size={18} />} />
    <SelectControl label={effects.title} options={snapshot.effects.map((option) => ({ value: option.value, label: effects[option.value] }))} value={snapshot.effect}
      disabled={!!snapshot.pending || !snapshot.cameraAllowed || !snapshot.effectSupported} onChange={(event) => change("effect", event.target.value)} />
    {!snapshot.effectSupported && <p>{effects.unsupported}</p>}
    <SettingRow label={text.quality} icon={<Icon name="video" size={18} />} />
    <SelectControl label={text.quality} options={snapshot.qualities} value={snapshot.quality} disabled={!!snapshot.pending || !snapshot.cameraAllowed} onChange={(event) => change("quality", event.target.value)} />
    <SettingRow label={text.fps} />
    <SelectControl label={text.fps} options={snapshot.frameRates} value={snapshot.frameRate} disabled={!!snapshot.pending || !snapshot.cameraAllowed} onChange={(event) => change("frameRate", event.target.value)} />
    {snapshot.screenAvailable && <>
      <div className={styles.divider} />
      <SettingRow label={text.screenQuality} />
      <SelectControl label={text.screenQuality} options={snapshot.screenQualities} value={snapshot.screenQuality} disabled={!!snapshot.pending} onChange={(event) => change("screenQuality", event.target.value)} />
      <SettingRow label={text.screenFps} />
      <SelectControl label={text.screenFps} options={snapshot.screenFrameRates} value={snapshot.screenFrameRate} disabled={!!snapshot.pending} onChange={(event) => change("screenFrameRate", event.target.value)} />
      {snapshot.screenHintAvailable && <><SettingRow label={text.screenHint} /><SelectControl label={text.screenHint} options={snapshot.screenHints} value={snapshot.screenHint} disabled={!!snapshot.pending} onChange={(event) => change("screenHint", event.target.value)} /></>}
    </>}
    {snapshot.error && <p role="alert">{text.error}</p>}
  </section>;
}
