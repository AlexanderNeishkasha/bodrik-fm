"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import ParticipantsPanel from "./ParticipantsPanel";
import { useBackClose } from "../room/useBackClose";
import { transitionPanel } from "../room/panelMotion.mjs";
import styles from "./ParticipantsDock.module.css";

/** Normal nonmodal participants/lobby dock; visibility is source-derived and hiding never resets panel state. */
export default function ParticipantsDock({ source, onReady }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const english = snapshot.language === "en";
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  /** Close through the retained toggle owner; an unknown outcome is reported, not retried. */
  function close() {
    transitionPanel(() => {
      setFailed(false);
      source.execute({ type: "close" }).catch(() => { if (live.current) setFailed(true); });
    });
  }
  useBackClose(snapshot.visible, close);

  // The panel keeps the close control alongside its invite and room actions above the scrolling list.
  return <aside className={styles.dock} style={{ viewTransitionName: "meeting-participants" }} aria-label={english ? "Participants" : "Участники"} hidden={!snapshot.visible}>
    {failed && <p role="status" className={styles.status}>{english ? "Could not confirm closing." : "Не удалось подтвердить закрытие."}</p>}
    <div className={styles.body}><ParticipantsPanel source={source} onReady={onReady} headerControl={
      <button type="button" className={styles.close} onClick={close} aria-label={english ? "Close participants" : "Закрыть участников"}><X size={18} /></button>
    } /></div>
  </aside>;
}
