"use client";

import { useId, useSyncExternalStore } from "react";
import { MessagesSquare, X } from "lucide-react";
import ChatWorkspace from "./ChatWorkspace";
import { useBackClose } from "../room/useBackClose";
import { transitionPanel } from "../room/panelMotion.mjs";
import styles from "./ChatPanel.module.css";

/** Docked chat panel over the meeting chat source; hiding never resets its history or draft. */
export default function ChatPanel({ source, origin, onReady }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const id = useId();
  /** Use the same transition as the control bar for the close button and mobile Back. */
  function close() { transitionPanel(() => source.close()); }
  useBackClose(snapshot.visible, close);
  const english = snapshot.language === "en";
  const unavailable = snapshot.available === false;
  const selected = snapshot.conversations.find((item) => item.id === snapshot.selected);
  const members = snapshot.conversations.filter((item) => item.id !== "all" && item.available).length + 1;

  const text = english
    ? { title: "Chat", publicChat: "Public chat", everyone: `Everyone in the room: ${members}`, direct: "Private messages", conversation: "Conversation", close: "Close chat" }
    : { title: "Чат", publicChat: "Общий чат", everyone: `Все в комнате: ${members}`, direct: "Личные сообщения", conversation: "Беседа", close: "Закрыть чат" };

  return <aside className={styles.panel} style={{ viewTransitionName: "meeting-chat" }} aria-labelledby={id} hidden={!snapshot.visible}>
    <header className={styles.header}>
      <span className={styles.icon} aria-hidden="true"><MessagesSquare size={26} /></span>
      <div className={styles.titles}>
        <h2 id={id} className={styles.srOnly}>{text.title}</h2>
        <select className={styles.conversation} aria-label={text.conversation} value={snapshot.selected} disabled={unavailable}
          onChange={(event) => source.selectConversation(null, event.target.value)}>
          {snapshot.conversations.map((item) => <option key={item.id} value={item.id}>
            {item.id === "all" ? text.publicChat : item.name}{item.unread ? ` (${item.unread})` : ""}
          </option>)}
        </select>
        <span className={styles.subtitle}><span className={styles.online} aria-hidden="true" />{selected?.id === "all" || !selected ? text.everyone : text.direct}</span>
      </div>
      <div className={styles.actions}>
        <button type="button" aria-label={text.close} title={text.close} onClick={close}><X size={18} /></button>
      </div>
    </header>
    <div className={styles.body}><ChatWorkspace source={source} origin={origin} submit={source.submit} onReady={onReady} /></div>
  </aside>;
}
