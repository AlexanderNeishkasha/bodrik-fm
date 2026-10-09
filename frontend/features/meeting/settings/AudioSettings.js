"use client";

import { useEffect, useSyncExternalStore } from "react";
import { SettingRow, SettingSwitch } from "./SettingControls";
import MicProcessingSettings from "./MicProcessingSettings";
import SpeakerVolumeSettings from "./SpeakerVolumeSettings";
import Icon from "../../../components/ui/Icon";
import SelectControl from "../../../components/ui/SelectControl";
import Button from "../../../components/ui/Button";
import styles from "./AudioSettings.module.css";

/** Maintain RU/EN audio copy in React, never through the legacy DOM translator. */
const copy = {
  ru: { title: "Аудио", intro: "Выберите микрофон и динамики, затем настройте звук встречи.", mic: "Микрофон", speaker: "Динамик", noise: "Шумоподавление", off: "Выключено", browser: "Базовое", enhanced: "Усиленное", noiseHelp: "Базовое: снижает фоновый шум с небольшой нагрузкой. Усиленное: сильнее подавляет шум, но использует больше CPU и батареи. Выключено: без фильтрации шума.", help: "Справка", test: "Проверить", stopTest: "Остановить", ptt: "Push-to-talk", focus: "Фокус на говорящем", focusHelp: "Выделяет участника, который сейчас говорит.", empty: "Устройства не найдены", level: "Уровень микрофона" },
  en: { title: "Audio", intro: "Select your microphone and speakers, then adjust meeting audio.", mic: "Microphone", speaker: "Speaker", noise: "Noise suppression", off: "Off", browser: "Basic", enhanced: "Enhanced", noiseHelp: "Basic: reduces background noise with low processing load. Enhanced: stronger filtering, using more CPU and battery. Off: no noise filtering.", help: "Help", test: "Test", stopTest: "Stop", ptt: "Push to talk", focus: "Speaker focus", focusHelp: "Highlights the participant who is currently speaking.", empty: "No devices found", level: "Microphone level" },
};

/** Consume the existing meter independently of control snapshots; no second capture/audio graph is created. */
function InputMeter({ source, label }) {
  const level = useSyncExternalStore(source.subscribeLevel, source.getInputLevel, source.getInputLevel);
  const active = Math.round(level * 10);
  return <div className={styles.meter} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
    {Array.from({ length: 10 }, (_, index) => <span key={index} className={index < active ? styles.activeBar : styles.bar} />)}
  </div>;
}

/** Render the complete audio tab from the single legacy runtime/command authority. */
export default function AudioSettings({ source, onReady }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = copy[snapshot.language === "en" ? "en" : "ru"];
  /** Commands publish errors and rollback to the same source instead of an optimistic UI copy. */
  async function change(key, value) {
    try { await source.execute(key, value); }
    catch { console.warn("Audio settings command rejected; see settings status"); }
  }
  const modes = [{ value: "off", label: text.off }, { value: "browser", label: text.browser }];
  if (snapshot.enhancedAvailable) modes.push({ value: "rnnoise", label: text.enhanced });
  return <section className={styles.section} lang={snapshot.language} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <header className={styles.header}><h3>{text.title}</h3><p>{text.intro}</p></header>
    <SettingRow label={text.mic} icon={<Icon name="mic" size={18} />} />
    <SelectControl label={text.mic} options={snapshot.inputDevices} placeholder={text.empty} value={snapshot.inputDevice} disabled={!!snapshot.pending || !snapshot.microphoneAvailable || !snapshot.inputDevices.length} onChange={(event) => change("inputDevice", event.target.value)} />
    <InputMeter source={source} label={text.level} />
    {snapshot.processingAvailable && <>
      <SettingRow className={styles.noiseRow} label={text.noise} icon={<Icon name="ear" size={18} />} description={text.noiseHelp} helpLabel={text.help}>
        <SelectControl className={styles.noiseSelect} label={text.noise} options={modes} value={snapshot.noiseMode} disabled={!!snapshot.pending || !snapshot.microphoneAvailable} onChange={(event) => change("noiseMode", event.target.value)} />
      </SettingRow>
      <MicProcessingSettings source={source} />
    </>}
    <div className={styles.divider} />
    {snapshot.outputSelectionAvailable && <>
      <SettingRow label={text.speaker} icon={<Icon name="headphones" size={18} />} />
      <div className={styles.speakerRow}><SelectControl label={text.speaker} options={snapshot.outputDevices} value={snapshot.outputDevice} disabled={!!snapshot.pending} onChange={(event) => change("outputDevice", event.target.value)} /><Button disabled={!!snapshot.pending} onClick={() => change("testSpeaker")}><Icon name={snapshot.speakerTestPlaying ? "stop" : "play"} size={16} />{snapshot.speakerTestPlaying ? text.stopTest : text.test}</Button></div>
    </>}
    {!snapshot.outputSelectionAvailable && <Button disabled={!!snapshot.pending} onClick={() => change("testSpeaker")}><Icon name={snapshot.speakerTestPlaying ? "stop" : "play"} size={16} />{snapshot.speakerTestPlaying ? text.stopTest : text.test}</Button>}
    <SpeakerVolumeSettings source={source} />
    {snapshot.pttAvailable && <SettingRow label={text.ptt} icon={<Icon name="hand" size={18} />} ><SettingSwitch label={text.ptt} checked={snapshot.pushToTalk} disabled={!!snapshot.pending} onChange={(value) => change("pushToTalk", value)} /></SettingRow>}
    {snapshot.focusAvailable && <SettingRow label={text.focus} icon={<Icon name="focus" size={18} />} description={text.focusHelp} helpLabel={text.help}><SettingSwitch label={text.focus} checked={snapshot.speakerFocus} disabled={!!snapshot.pending} onChange={(value) => change("speakerFocus", value)} /></SettingRow>}
    {!snapshot.processingAvailable && snapshot.error && <p role="alert">{snapshot.language === "en" ? "Could not update audio settings. Please try again." : "Не удалось изменить настройки звука. Попробуйте ещё раз."}</p>}
  </section>;
}
