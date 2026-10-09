"use client";

import { useEffect, useSyncExternalStore } from "react";
import { SettingRow, SettingSwitch } from "./SettingControls";
import styles from "./SettingsSection.module.css";
import Icon from "../../../components/ui/Icon";

/** Localized processing copy is React-owned, outside the legacy DOM translator. */
const copy = {
  ru: { help: "Справка", echo: "Эхоподавление", echoHelp: "Уменьшает попадание звука из динамиков обратно в микрофон.", gain: "Выравнивание громкости", gainHelp: "Автоматически подстраивает громкость микрофона.", enabled: "включено", disabled: "выключено", effective: "Фактически сейчас: ", error: "Не удалось изменить настройки звука. Попробуйте ещё раз." },
  en: { help: "Help", echo: "Echo cancellation", echoHelp: "Reduces speaker audio picked up by the microphone.", gain: "Automatic gain control", gainHelp: "Automatically adjusts microphone volume.", enabled: "on", disabled: "off", effective: "Currently applied: ", error: "Could not update audio settings. Please try again." },
};

/** Render shared processing controls from one external authority; the view never captures media. */
export default function MicProcessingSettings({ source, onReady }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = copy[snapshot.language === "en" ? "en" : "ru"];
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
  return <section onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }} className={styles.section} aria-label={snapshot.language === "en" ? "Microphone processing" : "Обработка микрофона"} lang={snapshot.language}>
    <SettingRow icon={<Icon name="headphones" size={18} />} helpLabel={text.help} label={text.echo} description={description(text.echoHelp, "echoCancellation", "effectiveEchoCancellation")}><SettingSwitch label={text.echo} checked={snapshot.echoCancellation === true} disabled={!!snapshot.pending} onChange={(enabled) => change("echoCancellation", enabled)} /></SettingRow>
    <SettingRow icon={<Icon name="audio-lines" size={18} />} helpLabel={text.help} label={text.gain} description={description(text.gainHelp, "autoGainControl", "effectiveAutoGainControl")}><SettingSwitch label={text.gain} checked={snapshot.autoGainControl === true} disabled={!!snapshot.pending} onChange={(enabled) => change("autoGainControl", enabled)} /></SettingRow>
    {snapshot.error && <p className={styles.status} role="alert">{text.error}</p>}
  </section>;
}
