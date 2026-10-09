"use client";

import { useState } from "react";
import Icon from "../../../components/ui/Icon";
import { attachmentSize } from "./chatAttachment.mjs";
import styles from "./ChatFileAttachment.module.css";

/** Localized transfer state; completion never implies that a person opened the file. */
const COPY = {
  ru: { preparing: "Подготовка…", transferring: "Передача…", completed: "", failed: "Не удалось передать файл", cancelled: "Передача отменена", unavailable: "Файл больше недоступен", download: "Скачать", cancel: "Отменить передачу", error: "Не удалось выполнить действие" },
  en: { preparing: "Preparing…", transferring: "Transferring…", completed: "", failed: "File transfer failed", cancelled: "Transfer cancelled", unavailable: "File no longer available", download: "Download", cancel: "Cancel transfer", error: "Could not complete the action" },
};

/** Document bubble backed by verified bytes; no file HTML or remote document embeds are rendered. */
export default function ChatFileAttachment({ attachment, source, language = "ru" }) {
  const text = COPY[language === "en" ? "en" : "ru"];
  const [error, setError] = useState(false);
  const active = ["preparing", "transferring"].includes(attachment.phase);
  const downloadable = attachment.phase === "completed" && attachment.downloadable;
  const phase = attachment.phase === "completed" && !downloadable ? "unavailable" : attachment.phase;
  /** Report rejected download/cancel actions without exposing transport internals. */
  async function act(operation) {
    setError(false);
    try { await operation(); }
    catch { setError(true); }
  }
  return <div className={styles.attachment} data-chat-file="" data-transfer-phase={phase}>
    <button type="button" className={styles.document} disabled={!downloadable}
      aria-label={`${text.download}: ${attachment.name}`} onClick={() => act(() => source.download(attachment.id))}>
      <span className={styles.icon}><Icon name="document" size={24} className="" /></span>
      <span className={styles.details}><strong>{attachment.name}</strong><span>{attachmentSize(attachment.size, language)}</span></span>
    </button>
    {active && <><progress className={styles.progress} aria-label={text.transferring} value={attachment.transferred} max={attachment.size} />
      <button type="button" className={styles.cancel} aria-label={text.cancel} title={text.cancel} onClick={() => act(() => source.cancelTransfer(attachment.id))}><Icon name="close" size={18} /></button></>}
    {(text[phase] || error) && <span className={styles.status} role="status">{error ? text.error : text[phase]}</span>}
  </div>;
}
