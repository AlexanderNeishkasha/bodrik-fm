"use client";

import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import Icon from "../../../components/ui/Icon";
import styles from "./SettingsShell.module.css";
import { bindSettingsDialog } from "./settingsDialogLifecycle.mjs";
import { useBackClose } from "../room/useBackClose";

/** Retained section labels and visual grouping; availability remains source-owned. */
const copy = {
  ru: { title: "Настройки встречи", close: "Закрыть настройки", devices: "Устройства", meeting: "Встреча", personal: "Личное",
    tabAudioDevices: "Звук", tabVideoDevices: "Видео", tabProfile: "Профиль",
    tabRoom: "Комната", tabModerator: "Модератор", tabShortcuts: "Горячие клавиши",
    tabLanguages: "Язык" },
  en: { title: "Meeting settings", close: "Close settings", devices: "Devices", meeting: "Meeting", personal: "Personal",
    tabAudioDevices: "Audio", tabVideoDevices: "Video", tabProfile: "Profile",
    tabRoom: "Room", tabModerator: "Moderator", tabShortcuts: "Shortcuts",
    tabLanguages: "Language" },
};

const groups = [
  { key: "devices", sections: ["tabAudioDevices", "tabVideoDevices"] },
  { key: "meeting", sections: ["tabProfile", "tabRoom", "tabModerator"] },
  { key: "personal", sections: ["tabShortcuts", "tabLanguages"] },
];
const icons = { tabAudioDevices: "mic", tabVideoDevices: "video", tabProfile: "profile",
  tabRoom: "room", tabModerator: "moderator", tabShortcuts: "shortcuts",
  tabLanguages: "language" };

/** Render navigation around caller-owned panels; mounting/closing never owns the call or a feature source. */
export default function SettingsShell({ source, renderSection, onReady, overlayDocument }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const dialogRef = useRef(null);
  const id = useId();
  const text = copy[snapshot.language === "en" ? "en" : "ru"];

  useBackClose(snapshot.open, () => source.execute("close"));
  useEffect(() => { onReady?.(); }, [onReady]);
  useEffect(() => {
    const lifecycle = bindSettingsDialog(dialogRef.current, {
      getSnapshot: source.getSnapshot, close: () => source.execute("close"), overlayDocument,
    });
    const unsubscribe = source.subscribe(lifecycle.sync);
    lifecycle.sync();
    return () => { unsubscribe(); lifecycle.dispose(); };
  }, [source, overlayDocument]);

  /** Use explicit close, not a toggle which could reopen on repeated Escape/close events. */
  function close() { source.execute("close"); }
  /** Rove native tab focus and source selection together; unrelated meeting shortcuts never see these keys. */
  function navigate(event) {
    const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const available = snapshot.available;
    const current = available.indexOf(snapshot.selected);
    const index = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 :
      (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : available.length - 1)) % available.length;
    source.execute("select", available[index]);
    event.currentTarget.querySelectorAll('[role="tab"]')[index]?.focus();
  }

  return <dialog ref={dialogRef} className={styles.dialog} lang={snapshot.language} aria-labelledby={`${id}-title`}
    onKeyDown={(event) => event.stopPropagation()}>
    <header className={styles.header}><h2 id={`${id}-title`}>{text.title}</h2>
      <button type="button" className={styles.close} aria-label={text.close} title={text.close} onClick={close}><X size={18} /></button></header>
    <div className={styles.body}>
      <nav className={styles.navigation} role="tablist" aria-label={text.title} onKeyDown={navigate}>
        {groups.map((group) => {
          const available = group.sections.filter((section) => snapshot.available.includes(section));
          if (!available.length) return null;
          return <div className={styles.group} key={group.key}>
            <span className={styles.groupLabel}>{text[group.key]}</span>
            {available.map((section) => <button key={section} type="button" role="tab" title={text[section]}
              data-tooltip={text[section]} id={`${id}-${section}-tab`} aria-controls={`${id}-${section}-panel`}
              aria-selected={section === snapshot.selected} tabIndex={section === snapshot.selected ? 0 : -1}
              onClick={() => source.execute("select", section)}><Icon name={icons[section]} size={19} />
              <span className={styles.tabLabel}>{text[section]}</span></button>)}
          </div>;
        })}
      </nav>
      <div className={styles.panels}>
        {snapshot.available.map((section) => <section key={section} role="tabpanel"
          id={`${id}-${section}-panel`} aria-labelledby={`${id}-${section}-tab`} hidden={section !== snapshot.selected}>
          {renderSection(section)}
        </section>)}
      </div>
    </div>
  </dialog>;
}
