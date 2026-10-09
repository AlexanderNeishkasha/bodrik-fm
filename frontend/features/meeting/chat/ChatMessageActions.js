"use client";

import { useEffect, useRef, useState } from "react";
import { EllipsisVertical, Trash2 } from "lucide-react";
import styles from "./ChatMessageActions.module.css";

/**
 * "⋮" button beside the bubble (revealed on hover) and its menu; the transcript also
 * opens the menu on right-click/long-press. Public removal waits for storage acknowledgement.
 */
export default function ChatMessageActions({ source, message, language, sessionKey, side = "left", open, onOpenChange }) {
  const english = language === "en";
  const ref = useRef(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  // Close on an outside press or Escape while open.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => { if (!ref.current?.contains(event.target)) onOpenChange(false); };
    const escape = (event) => { if (event.key === "Escape") onOpenChange(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onOpenChange]);

  const label = english ? "Message actions" : "Действия с сообщением";
  return <div ref={ref} data-side={side} className={`${styles.anchor} ${open ? styles.open : ""}`}>
    <button className={styles.trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label}
      onClick={() => onOpenChange(!open)}><EllipsisVertical size={16} /></button>
    {open && <div className={styles.menu} role="menu" aria-label={label}>
      <button type="button" role="menuitem" className={styles.danger} disabled={pending} onClick={async () => {
        setPending(true); setError(false);
        try { await source.remove(message.key, sessionKey); onOpenChange(false); }
        catch { setError(true); }
        finally { setPending(false); }
      }}>
        <Trash2 size={15} /> {english ? "Delete" : "Удалить"}
      </button>
      {error && <span role="alert">{english ? "Could not delete" : "Не удалось удалить"}</span>}
    </div>}
  </div>;
}
