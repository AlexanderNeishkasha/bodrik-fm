"use client";

import { useId, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import ChatMessageActions from "./ChatMessageActions";
import ChatPersistentImage from "./ChatPersistentImage";
import ChatFileAttachment from "./ChatFileAttachment";
import ChatMessageContent from "./ChatMessageContent";
import { safeChatAvatar } from "./chatAvatar.mjs";
import styles from "./ChatTranscript.module.css";
import { t } from "../../../app/lang/index.js";

/** Use a validated public avatar or inert initials; failed/revoked images never break the message row. */
function MessageAvatar({ name, url }) {
  const [failed, setFailed] = useState(false);
  return <span className={styles.avatar}>
    {url && !failed ? <Image unoptimized width={40} height={40} src={url} alt={`${t("meeting.chatTranscript.avatar")}${name}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> :
      <span aria-hidden="true">{Array.from(name.trim()).slice(0, 2).join("").toUpperCase()}</span>}
  </span>;
}

/** Render the authoritative conversation with retained outgoing/incoming bubbles; no delivery status is fabricated. */
export default function ChatTranscript({ source, origin }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const messages = snapshot.messages.filter((message) => (message.targetId === "all" ? "all" : message.direction === "outgoing" ? message.targetId : message.peerId) === snapshot.selected);
  const titleId = useId();
  const text = t("meeting.chatTranscript");
  // At most one message menu is open; right-click (long-press on touch) opens it too.
  const [menu, setMenu] = useState(null);
  return <section className={styles.panel} aria-labelledby={titleId}>
    {/* Nested under the panel's visible "Chat" heading; a distinct level/name avoids a duplicate h2. */}
    <h3 id={titleId} className={styles.srOnly}>{text.messages}</h3>
    <span className={styles.srOnly}>{text.unread}: {snapshot.unread}</span>
    {!messages.length && <p className={styles.empty}>{text.empty}</p>}
    <ol className={styles.messages} aria-label={text.messages}>
      {messages.map((message) => {
        const outgoing = message.direction === "outgoing";
        const avatar = safeChatAvatar(message.avatar || source.getAvatar?.(message.peerId), origin);
        const deletable = typeof source.remove === "function" && (outgoing || snapshot.canModerate);
        return <li key={message.key} className={`${styles.message} ${outgoing ? styles.outgoing : styles.incoming}`}
          onContextMenu={deletable ? (event) => { event.preventDefault(); setMenu(message.key); } : undefined}>
          <header className={styles.metadata}>
            <span className={styles.identity}><time dateTime={new Date(message.receivedAt).toISOString()}>{new Date(message.receivedAt).toLocaleTimeString(text.locale)}</time>, {message.name}{outgoing && (text.me)}</span>
            <MessageAvatar key={`${message.peerId}:${avatar}`} name={message.name} url={avatar} />
            <span className={styles.srOnly}>{message.targetId === "all" ? (text.public) : (text.private)}</span>
          </header>
          <div className={styles.bubble}>
            {message.attachment?.kind === "image" ? snapshot.visible ? <ChatPersistentImage key={message.attachment.id} attachment={message.attachment} source={source} /> : null : message.attachment ? <ChatFileAttachment attachment={message.attachment} source={source} /> : null}
            {(!message.attachment || message.durableId && message.body) && <ChatMessageContent body={message.body} origin={origin} />}
            {deletable && <ChatMessageActions key={`${snapshot.sessionKey}:${message.key}`} source={source} message={message} sessionKey={snapshot.sessionKey}
              side={outgoing ? "left" : "right"} open={menu === message.key} onOpenChange={(value) => setMenu(value ? message.key : null)} />}
          </div>
        </li>;
      })}
    </ol>
  </section>;
}
