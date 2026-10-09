"use client";

import { useState, useSyncExternalStore } from "react";
import { AudioLines, Check, Mic, Play, Settings, Square, Volume2 } from "lucide-react";

import SelectControl from "../../../components/ui/SelectControl";
import SwitchControl from "../../../components/ui/SwitchControl";
import styles from "./MicQuickMenu.module.css";

/** RU/EN copy. */
const COPY = {
  ru: { microphones: "Микрофоны", processing: "Настройки микрофона", noise: "Шумоподавление", off: "Выключено", browser: "Базовое", enhanced: "Усиленное", echo: "Эхоподавление", gain: "Выравнивание громкости", speakers: "Динамики", volume: "Громкость динамика", test: "Проверить динамики", stopTest: "Остановить", open: "Открыть настройки звука", unavailable: "Недоступен", level: "Уровень микрофона" },
  en: { microphones: "Microphones", processing: "Microphone settings", noise: "Noise suppression", off: "Off", browser: "Basic", enhanced: "Enhanced", echo: "Echo cancellation", gain: "Auto gain control", speakers: "Speakers", volume: "Speaker volume", test: "Test speakers", stopTest: "Stop", open: "Open audio settings", unavailable: "Unavailable", level: "Microphone level" },
};

/** Raw per-device meter; inaccessible inputs are distinct from silence. */
function Level({ reading, label, unavailable }) {
  const level = reading?.level || 0;
  if (reading?.status === "unavailable") return <span className={styles.unavailable} title={unavailable} aria-label={`${label}: ${unavailable}`}>—</span>;
  const active = Math.round(level * 10);
  return <span className={styles.level} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
    {Array.from({ length: 10 }, (_, index) => <span key={index} className={index < active ? styles.barOn : styles.bar} />)}
  </span>;
}

/** One on/off switch row. */
function Toggle({ label, checked, disabled, onChange }) {
  return <label className={styles.row}>
    <span>{label}</span>
    <SwitchControl label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
  </label>;
}

/** Quick microphone and speaker menu shown above the mic button. */
export default function MicQuickMenu({ audio, onOpenSettings, onError, language = "ru" }) {
  const snapshot = useSyncExternalStore(audio.subscribe, audio.getSnapshot, audio.getSnapshot);
  const [comparison] = useState(() => audio.createInputComparison());
  const levels = useSyncExternalStore(comparison.subscribe, comparison.getSnapshot, comparison.getSnapshot);
  const text = COPY[language === "en" ? "en" : "ru"];
  const busy = Boolean(snapshot.pending);

  /** Run one audio setting change. */
  function change(key, value) {
    audio.execute(key, value).catch((error) => onError?.(error));
  }

  const modes = [["off", text.off], ["browser", text.browser], ...(snapshot.enhancedAvailable ? [["rnnoise", text.enhanced]] : [])];
  return <div style={{ viewTransitionName: "meeting-control-menu" }} className={styles.menu} role="menu" aria-label={text.microphones}>
    <p className={styles.title}><Mic size={14} aria-hidden="true" /> {text.microphones}</p>
    {snapshot.inputDevices.map((device) => {
      const selected = device.value === snapshot.inputDevice;
      return <button key={device.value} type="button" role="menuitemradio" aria-checked={selected} className={styles.device} disabled={busy}
        onClick={() => change("inputDevice", device.value)}>
        <span className={styles.check}>{selected && <Check size={14} />}</span>
        <span className={styles.label}>{device.label}</span>
        <Level reading={levels[device.value]} label={`${text.level}: ${device.label}`} unavailable={text.unavailable} />
      </button>;
    })}
    <p className={styles.title}><AudioLines size={14} aria-hidden="true" /> {text.processing}</p>
    <div className={styles.row}>
      <span>{text.noise}</span>
      <SelectControl label={text.noise} className={styles.noiseSelector} options={modes.map(([value, label]) => ({ value, label }))}
        value={snapshot.noiseMode} disabled={busy} onChange={(event) => change("noiseMode", event.target.value)} />
    </div>
    <Toggle label={text.echo} checked={snapshot.echoCancellation} disabled={busy} onChange={(value) => change("echoCancellation", value)} />
    <Toggle label={text.gain} checked={snapshot.autoGainControl} disabled={busy} onChange={(value) => change("autoGainControl", value)} />
    {snapshot.outputSelectionAvailable && snapshot.outputDevices.length > 0 && <>
      <p className={styles.title}><Volume2 size={14} aria-hidden="true" /> {text.speakers}</p>
      {snapshot.outputDevices.map((device) => {
        const selected = device.value === snapshot.outputDevice || (!snapshot.outputDevice && device.value === "default");
        return <button key={device.value} type="button" role="menuitemradio" aria-checked={selected} className={styles.device} disabled={busy}
          onClick={() => change("outputDevice", device.value)}>
          <span className={styles.check}>{selected && <Check size={14} />}</span>
          <span className={styles.label}>{device.label}</span>
        </button>;
      })}
    </>}
    <label className={styles.volume}>
      <Volume2 size={18} aria-hidden="true" />
      <input type="range" min={0} max={100} step={1} aria-label={text.volume} value={snapshot.speakerVolume}
        onChange={(event) => audio.setVolume(Number(event.target.value), true)} />
      <span>{snapshot.speakerVolume}%</span>
    </label>
    <button type="button" role="menuitem" className={styles.action} onClick={() => change("testSpeaker")}>{snapshot.speakerTestPlaying ? <Square size={16} /> : <Play size={16} />} {snapshot.speakerTestPlaying ? text.stopTest : text.test}</button>
    <button type="button" role="menuitem" className={styles.action} onClick={onOpenSettings}><Settings size={16} /> {text.open}</button>
  </div>;
}
