"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Clock, House, Share2 } from "lucide-react";

import styles from "./RoomInfo.module.css";

/** RU/EN copy. */
const copy = {
  ru: { title: "Настройки комнаты", intro: "Управляйте доступом, приглашениями и предпочтениями в комнате.", share: "Поделиться комнатой", time: "Время во встрече" },
  en: { title: "Room settings", intro: "Manage access, invitations and your room preferences.", share: "Share room", time: "Time in meeting" },
};

/** Elapsed time as HH:MM:SS. */
function elapsed(since, now) {
  return since ? new Date(Math.max(0, now - since)).toISOString().slice(11, 19) : "00:00:00";
}

/** Room header: slug with share action and the session timer. */
export default function RoomInfo({ source, onReady }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const text = copy[snapshot.language === "en" ? "en" : "ru"];
  const [now, setNow] = useState(() => Date.now());
  const slug = typeof window === "undefined" ? "" : decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) || "");
  useEffect(() => { onReady?.(); }, [onReady]);
  // Tick the session timer once a second while the tab is mounted.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <section className={styles.section} lang={snapshot.language}>
    <header><h3>{text.title}</h3><p>{text.intro}</p></header>
    <div className={styles.row}>
      <House size={18} aria-hidden="true" /><span className={styles.slug}>{slug}</span>
      <button type="button" aria-label={text.share} title={text.share} disabled={!snapshot.available}
        onClick={() => source.execute("share").catch(() => {})}><Share2 size={16} /></button>
    </div>
    <div className={styles.row} aria-label={text.time}><Clock size={18} aria-hidden="true" /><span>{elapsed(snapshot.joinedAt, now)}</span></div>
  </section>;
}
