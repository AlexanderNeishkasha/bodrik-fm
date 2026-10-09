"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, X } from "lucide-react";

import styles from "./ShareDialog.module.css";

/** RU/EN copy. */
const COPY = {
  ru: { title: "Поделиться комнатой", link: "Ссылка-приглашение", copy: "Скопировать ссылку", copied: "Ссылка скопирована", close: "Закрыть" },
  en: { title: "Share room", link: "Invitation link", copy: "Copy link", copied: "Link copied", close: "Close" },
};

/** Modal with the room's public invitation link and a copy button. */
export default function ShareDialog({ url, language = "ru", onClose }) {
  const text = COPY[language === "en" ? "en" : "ru"];
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);

  // Show as a modal and return focus when closed.
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  /** Copy the link (share sheet on devices that have one). */
  async function copy() {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ url }).catch(() => {});
      return;
    }
    await navigator.clipboard.writeText(url);
    setCopied(true);
  }

  return <dialog ref={ref} className={styles.dialog} aria-labelledby="meeting-share-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className={styles.header}>
      <h2 id="meeting-share-title">{text.title}</h2>
      <button type="button" className={styles.icon} aria-label={text.close} onClick={onClose}><X size={18} /></button>
    </header>
    <p className={styles.label}>{text.link}:</p>
    <a className={styles.link} href={url} target="_blank" rel="noreferrer">{url}</a>
    <div className={styles.actions}>
      <button type="button" className={styles.primary} onClick={() => copy().catch(() => {})}><Copy size={16} /> {copied ? text.copied : text.copy}</button>
      <button type="button" className={styles.secondary} onClick={onClose}>{text.close}</button>
    </div>
  </dialog>;
}
