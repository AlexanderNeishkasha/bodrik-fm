"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { X } from "lucide-react";

import styles from "./ShareDialog.module.css";

/** RU/EN copy per confirmation kind. */
const COPY = {
  ru: { ban: { title: "Забанить участника?", body: "{name} не сможет вернуться в эту комнату 24 часа.", confirm: "Забанить" }, cancel: "Отмена" },
  en: { ban: { title: "Ban this participant?", body: "{name} will not be able to return to this room for 24 hours.", confirm: "Ban" }, cancel: "Cancel" },
};

/** The room's confirmation modal (player style, like Studio's delete dialog). */
export default function ConfirmDialog({ confirmations, language = "ru" }) {
  const request = useSyncExternalStore(confirmations.subscribe, confirmations.getSnapshot, confirmations.getSnapshot);
  if (!request) return null;
  return <Dialog key={request.id} request={request} confirmations={confirmations} language={language} />;
}

/** One open confirmation; focus starts on Cancel and Escape cancels. */
function Dialog({ request, confirmations, language }) {
  const all = COPY[language === "en" ? "en" : "ru"];
  const text = all[request.kind] || all.ban;
  const ref = useRef(null);
  const cancel = useRef(null);

  // Show as a modal; answer "no" if it goes away unanswered; restore focus.
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    cancel.current?.focus();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return <dialog ref={ref} className={styles.dialog} aria-labelledby="meeting-confirm-title"
    onCancel={(event) => { event.preventDefault(); confirmations.answer(false); }}>
    <header className={styles.header}>
      <h2 id="meeting-confirm-title">{text.title}</h2>
      <button type="button" className={styles.icon} aria-label={all.cancel} onClick={() => confirmations.answer(false)}><X size={18} /></button>
    </header>
    <p className={styles.label}>{text.body.replace("{name}", request.name || "")}</p>
    <div className={styles.actions}>
      <button ref={cancel} type="button" className={styles.secondary} onClick={() => confirmations.answer(false)}>{all.cancel}</button>
      <button type="button" className={`${styles.primary} ${styles.danger}`} onClick={() => confirmations.answer(true)}>{text.confirm}</button>
    </div>
  </dialog>;
}
