"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { clearCachedAuthUser, getCachedAuthRole, setCachedAuthUser } from "../lib/authSession";
import RoomListPanel from "./RoomListPanel";
import styles from "./RoomsScreen.module.css";

const INITIAL_LOADING_DELAY = 200;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001";

/** Shows available rooms and routes authenticated users to their studio. */
export default function RoomsScreen({ rooms, roomsStatus, onNavigateToRoom }) {
  const router = useRouter();
  const isInitialLoading = roomsStatus === "loading" && rooms.length === 0;
  const [initialLoadingDelayPassed, setInitialLoadingDelayPassed] = useState(() => !isInitialLoading);

  useEffect(() => {
    if (!isInitialLoading || initialLoadingDelayPassed) {
      return;
    }
    const timeoutId = setTimeout(() => {
      setInitialLoadingDelayPassed(true);
    }, INITIAL_LOADING_DELAY);
    return () => clearTimeout(timeoutId);
  }, [initialLoadingDelayPassed, isInitialLoading]);

  const showPanel = !isInitialLoading || initialLoadingDelayPassed;

  const openStudio = async (event) => {
    const role = getCachedAuthRole();
    if (role === "admin") {
      event.preventDefault();
      router.push("/puppet_master");
      return;
    }
    if (role) {
      return;
    }

    event.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        credentials: "include",
      });
      if (res.status === 401) {
        clearCachedAuthUser();
        router.push("/studio");
        return;
      }
      if (!res.ok) {
        router.push("/studio");
        return;
      }
      const payload = await res.json();
      setCachedAuthUser(payload);
      const nextRole = payload?.actor_role ?? payload?.role;
      router.push(nextRole === "admin" ? "/puppet_master" : "/studio");
    } catch {
      router.push("/studio");
    }
  };

  return (
    <div className={`${styles.screen} hero-bg min-h-screen text-[var(--theme-text)]`}>
      <div className={`${styles.shell} mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16`}>
        {showPanel ? (
          <main
            className={`${styles.panel} ${styles.panelEnter} panel-shadow-hero space-y-6 rounded-[32px] border border-[var(--theme-border)] bg-[var(--theme-card)] p-10`}
          >
            <h1 className="text-2xl font-semibold font-display tracking-[0.08em]">Бодрик FM</h1>
            <p className="text-sm text-[var(--theme-muted)]">Доступные комнаты</p>
            <RoomListPanel rooms={rooms} roomsStatus={roomsStatus} onNavigateToRoom={onNavigateToRoom} />
            <div className={`${styles.actions} flex flex-wrap items-center gap-4`}>
              <Link
                href="/studio"
                onClick={openStudio}
                className={`${styles.studioLink} btn-accent inline-flex w-fit rounded-full bg-[var(--theme-accent)] px-5 py-2 text-sm font-semibold text-[var(--theme-text-dark)]`}
              >
                Открыть студию
              </Link>
            </div>
          </main>
        ) : null}
      </div>
    </div>
  );
}
