"use client";

import { useSyncExternalStore } from "react";
import { Check, Settings, Sparkles, Video } from "lucide-react";

import { effectLabels } from "../media/cameraEffects.mjs";
import styles from "./MicQuickMenu.module.css";

/** RU/EN copy. */
const COPY = {
  ru: { cameras: "Камеры", open: "Открыть настройки видео" },
  en: { cameras: "Cameras", open: "Open video settings" },
};

/** Quick camera menu above the camera button: devices and background effect, like the mic menu. */
export default function CameraQuickMenu({ video, onOpenSettings, onError, language = "ru" }) {
  const snapshot = useSyncExternalStore(video.subscribe, video.getSnapshot, video.getSnapshot);
  const text = COPY[language === "en" ? "en" : "ru"];
  const effects = effectLabels(language);
  const busy = Boolean(snapshot.pending) || !snapshot.cameraAllowed;

  /** Run one video setting change. */
  function change(key, value) {
    video.execute(key, value).catch((error) => onError?.(error));
  }

  /** One radio row with a check mark, as in the mic menu. */
  const row = (key, value, label, selected, disabled = busy) => <button key={value} type="button" role="menuitemradio" aria-checked={selected}
    className={styles.device} disabled={disabled} onClick={() => change(key, value)}>
    <span className={styles.check}>{selected && <Check size={14} />}</span>
    <span className={styles.label}>{label}</span>
  </button>;

  return <div style={{ viewTransitionName: "meeting-control-menu" }} className={styles.menu} role="menu" aria-label={text.cameras}>
    <p className={styles.title}><Video size={14} aria-hidden="true" /> {text.cameras}</p>
    {snapshot.cameras.map((device) => row("camera", device.value, device.label, device.value === snapshot.camera))}
    <p className={styles.title}><Sparkles size={14} aria-hidden="true" /> {effects.title}</p>
    {snapshot.effects.map((option) => row("effect", option.value, effects[option.value], option.value === snapshot.effect, busy || !snapshot.effectSupported))}
    {!snapshot.effectSupported && <p className={styles.note}>{effects.unsupported}</p>}
    <button type="button" role="menuitem" className={styles.action} onClick={onOpenSettings}><Settings size={16} /> {text.open}</button>
  </div>;
}
