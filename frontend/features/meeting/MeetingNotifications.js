"use client";

import { useEffect, useSyncExternalStore } from "react";
import Toast from "../../components/ui/Toast";
import styles from "./MeetingNotifications.module.css";

/** Render borrowed text-only notifications without creating timers or playing event sounds. */
export default function MeetingNotifications({ source, onReady }) {
  const notice = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  useEffect(() => { onReady(); }, [onReady]);
  return <Toast notice={notice?.text} severity={notice?.severity} className={styles.overlay} />;
}
