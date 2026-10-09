"use client";

import { useEffect, useImperativeHandle, useRef, useState } from "react";
import Image from "next/image";
import styles from "./ChatMessageContent.module.css";
import Icon from "../../../components/ui/Icon";
import { attachmentSize, CHAT_IMAGE_TYPES, validAttachment } from "./chatAttachment.mjs";
import Button from "../../../components/ui/Button";

/** Compose text for an injected command; submitted labels local dispatch, never server delivery.
 * Blob previews bypass optimization and use CSS auto sizing for their unknown dimensions.
 */
export default function ChatComposer({ submit, language = "ru", disabled = false, ref }) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [staged, setStaged] = useState(null);
  const attachment = useRef(null);
  const preview = useRef(null);
  const upload = useRef(null);
  const fileInput = useRef(null);
  const lifecycle = useRef({ live: false, busy: false, epoch: 0 });
  const english = language === "en";
  useEffect(() => {
    const state = lifecycle.current;
    state.live = true;
    return () => {
      state.live = false; state.epoch++;
      upload.current?.abort();
      if (preview.current) URL.revokeObjectURL(preview.current);
    };
  }, []);

  /** Validate and replace a staged attachment; preview URLs remain owned by this composer and never enter snapshots. */
  function attach(file) {
    if (pending || disabled || lifecycle.current.busy) return;
    if (file && !validAttachment(file)) {
      setStatus("invalid_file");
      return;
    }
    if (preview.current) URL.revokeObjectURL(preview.current);
    attachment.current = file;
    preview.current = file && CHAT_IMAGE_TYPES.includes(file.type) ? URL.createObjectURL(file) : null;
    setStaged(file ? { name: file.name, size: file.size, url: preview.current } : null);
    setStatus("");
  }

  /** Stage one dropped attachment through the same validation and preview ownership as the picker. */
  function attachFiles(files) {
    if (disabled || pending || lifecycle.current.busy) return;
    if (files.length !== 1) {
      if (files.length) setStatus("one_file");
      return;
    }
    attach(files[0]);
  }

  useImperativeHandle(ref, () => ({
    /** Whether the workspace can accept a drop into this conversation's composer. */
    canAttach: () => !disabled && !pending && !lifecycle.current.busy,
    attachFiles,
  }));

  /** Serialize local submits; obsolete completions cannot clear a replacement composer or disclose transport errors. */
  async function send(event) {
    event.preventDefault();
    const state = lifecycle.current;
    if (!state.live || state.busy || disabled || (!draft.trim() && !attachment.current)) return;
    state.busy = true;
    const epoch = state.epoch;
    setPending(true);
    setStatus("");
    try {
      const controller = new AbortController();
      upload.current = controller;
      const result = await submit(draft, { file: attachment.current, signal: controller.signal });
      if (!state.live || epoch !== state.epoch) return;
      if (!result || !["submitted", "rejected", "empty"].includes(result.status) || typeof result.clearDraft !== "boolean") throw new TypeError("Invalid local chat command result");
      if (result.clearDraft) {
        setDraft("");
      }
      if (result.clearDraft || result.clearAttachment) {
        if (preview.current) URL.revokeObjectURL(preview.current);
        preview.current = null;
        attachment.current = null;
        setStaged(null);
      }
      setStatus(result.status === "submitted" || result.status === "empty" ? "" :
        ["no_participants", "length", "rate_limit", "policy", "recipient", "caption"].includes(result.reason) ? result.reason : "rejected");
    } catch {
      if (state.live && epoch === state.epoch) setStatus("unknown");
    } finally {
      state.busy = false;
      if (state.live && epoch === state.epoch) setPending(false);
    }
  }

  return <form className={styles.composer} onSubmit={send}>
    {staged && <figure className={styles.preview}>
      {staged.url ? <Image unoptimized width={0} height={0} style={{ width: "auto", height: "auto" }} className={styles.previewImage} src={staged.url} alt={english ? "Image draft" : "Черновик изображения"} title={staged.name} /> : <span className={styles.documentIcon}><Icon name="document" size={25} className="" /></span>}
      <figcaption className={staged.url ? styles.srOnly : styles.documentDetails}><strong>{staged.name}</strong><span>{attachmentSize(staged.size, language)}</span></figcaption>
      <button className={styles.previewRemove} type="button" aria-label={english ? "Remove attachment" : "Убрать вложение"}
        title={english ? "Remove attachment" : "Убрать вложение"} disabled={pending} onClick={() => attach(null)}><Icon name="close" size={22} /></button>
    </figure>}
    <div className={styles.inputRow}>
      <button className={styles.attachmentButton} type="button" aria-label={english ? "Attach file" : "Прикрепить файл"}
        title={english ? "Attach file" : "Прикрепить файл"} disabled={disabled || pending} onClick={() => fileInput.current?.click()}><Icon name="attachment" size={22} className="" /></button>
      <textarea className={styles.textarea} aria-label={english ? "Message" : "Сообщение"}
      placeholder={staged ? (english ? "Add a caption…" : "Добавить подпись…") : (english ? "Type a message…" : "Введите сообщение…")} rows={Math.min(5, draft.split("\n").length)}
      value={draft} maxLength={4000} disabled={disabled || pending}
      onPaste={(event) => {
        const item = [...(event.clipboardData?.items || [])].find((entry) => entry.kind === "file");
        const file = item?.getAsFile() || event.clipboardData?.files?.[0];
        if (file) { event.preventDefault(); attach(file); }
      }}
      onChange={(event) => { setDraft(event.target.value); setStatus(""); }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) send(event);
      }} />
      <Button className={styles.send} type="submit" aria-label={english ? "Send" : "Отправить"} title={english ? "Send" : "Отправить"} disabled={disabled || pending || (!draft.trim() && !staged)}>
        <Icon name="send" size={21} /><span className={styles.srOnly}>{pending ? (english ? "Submitting…" : "Отправка…") : ""}</span>
      </Button>
    </div>
    <div className={styles.hints}><span>{english ? "Enter sends. Shift+Enter adds a line break." : "Enter отправляет. Shift+Enter добавляет перенос строки."}</span><span>{draft.length} / 4000</span></div>
    <input ref={fileInput} className={styles.fileInput} data-chat-attachment-picker="" type="file" aria-label={english ? "Attach file" : "Прикрепить файл"}
      disabled={disabled || pending} onChange={(event) => { if (event.target.files?.[0]) attach(event.target.files[0]); event.target.value = ""; }} />
    <p className={styles.status} role="status">{status === "unknown" ? (english ? "Submission could not be confirmed. Check before sending again." : "Отправка не подтверждена. Проверьте перед повторной отправкой.") :
      status === "one_file" ? (english ? "Attach one file at a time." : "Добавляйте по одному файлу.") :
      status === "invalid_file" ? (english ? "Choose an image up to 5 MB or a file up to 100 MB." : "Выберите изображение до 5 МБ или файл до 100 МБ.") :
      status === "caption" ? (english ? "File sent. The caption was not sent; try again." : "Файл отправлен. Подпись не отправилась — попробуйте ещё раз.") :
      status === "no_participants" ? (english ? "No other participants are available." : "Нет других участников для отправки.") :
      status === "length" ? (english ? "The message or caption is too long." : "Сообщение или подпись слишком длинные.") :
      status === "rate_limit" ? (english ? "Please wait before sending again." : "Подождите перед следующей отправкой.") :
      status === "policy" ? (english ? "Chat is restricted by the moderator." : "Чат ограничен модератором.") :
      status === "recipient" ? (english ? "The selected participant is no longer available." : "Выбранный участник больше недоступен.") :
      status ? (english ? "Message was not submitted. Check the connection, recipient and room restrictions." : "Сообщение не отправлено. Проверьте соединение, адресата и ограничения комнаты.") : ""}</p>
  </form>;
}
