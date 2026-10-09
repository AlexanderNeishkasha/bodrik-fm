"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { ui } from "../lang/ru";
import useAudioPulse from "../lib/useAudioPulse";
import useHydrated from "../lib/useHydrated";
import useMainHotkeys from "../lib/useMainHotkeys";
import useMainRoute from "../lib/useMainRoute";
import useMainVolume from "../lib/useMainVolume";
import usePersistedState from "../lib/usePersistedState";
import usePublicState from "../lib/usePublicState";
import usePublicAudioSync from "../lib/usePublicAudioSync";
import { applyTheme, getDefaultTheme, getStoredTheme } from "../lib/theme";
import HotkeysPanel from "./HotkeysPanel";
import MainPlayerPanel from "./MainPlayerPanel";
import playerStyles from "./MainPlayerPanel.module.css";
import BodrickFlyby from "./BodrickFlyby";
import NotFoundPanel from "./NotFoundPanel";
import RoomsScreen from "./RoomsScreen";
import PageTransition from "./PageTransition";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001";
const MEDIA_BASE = process.env.NEXT_PUBLIC_MEDIA_BASE || API_BASE;

/** Render the interactive room list/player inside the statically exported page. */
export default function PlayerApp() {
  const audioRef = useRef(null);
  const playButtonRef = useRef(null);
  const hlsRef = useRef(null);
  const {
    roomSlug,
    invalidPath,
    isRouteResolved,
    replaceRoom,
    navigateHome,
    navigateRoom,
  } = useMainRoute();
  const [rooms, setRooms] = useState([]);
  const [roomsStatus, setRoomsStatus] = useState("loading");

  useEffect(() => {
    if (!isRouteResolved) {
      return;
    }
    if (!roomSlug) {
      applyTheme(getStoredTheme() ?? getDefaultTheme(), { persist: false });
    }
  }, [isRouteResolved, roomSlug]);

  useEffect(() => {
    if (!isRouteResolved || roomSlug || invalidPath) {
      return;
    }
    let cancelled = false;
    const loadRooms = async () => {
      setRoomsStatus("loading");
      try {
        const res = await fetch(`${API_BASE}/api/rooms`);
        if (!res.ok) {
          if (!cancelled) {
            setRoomsStatus("error");
          }
          return;
        }
        const data = await res.json();
        if (cancelled) {
          return;
        }
        setRooms(Array.isArray(data) ? data : []);
        setRoomsStatus("ready");
      } catch {
        if (!cancelled) {
          setRoomsStatus("error");
        }
      }
    };
    loadRooms();
    return () => {
      cancelled = true;
    };
  }, [isRouteResolved, roomSlug, invalidPath]);

  const { status, currentTrack, isPlaying, position, syncToken } = usePublicState({
    apiBase: API_BASE,
    roomSlug,
    enabled: Boolean(roomSlug),
    onRoomSlugChanged: replaceRoom,
  });

  useEffect(() => {
    if (status !== "not_found" || !roomSlug || typeof window === "undefined") {
      return;
    }
    window.location.replace("/404");
  }, [status, roomSlug]);

  const isHydrated = useHydrated();
  const [showHotkeys, setShowHotkeys, hotkeysReady] = usePersistedState({
    key: "hotkeys_main",
    defaultValue: () => {
      if (typeof document === "undefined") {
        return true;
      }
      const attr = document.documentElement.getAttribute("data-hotkeys-main");
      if (attr == null) {
        return true;
      }
      return attr === "true";
    },
    parse: (value) => value === "true",
    onPersist: (value) => {
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-hotkeys-main", String(value));
      }
    },
  });
  const [isHatHidden, setIsHatHidden] = usePersistedState({
    key: "hat_hidden",
    defaultValue: () => {
      if (typeof document === "undefined") {
        return false;
      }
      return document.documentElement.getAttribute("data-hat-hidden") === "true";
    },
    parse: (value) => value === "true",
    onPersist: (value) => {
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-hat-hidden", String(value));
      }
    },
  });
  const [isFlybyActive, setIsFlybyActive] = useState(false);
  const [isHatBodrickActive, setIsHatBodrickActive] = useState(false);
  const [interactionToken, bumpInteraction] = useReducer((value) => value + 1, 0);

  useAudioPulse(audioRef, { enabled: true });

  const { volume, isMuted, isSliderReady, toggleMute, onVolumeChange, adjustVolume } = useMainVolume();

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, volume));
    audioRef.current.volume = clamped;
    audioRef.current.muted = isMuted;
  }, [roomSlug, volume, isMuted]);

  const { isLocalPaused, toggleLocalPause } = usePublicAudioSync({
    audioRef,
    hlsRef,
    currentTrack,
    isPlaying,
    position,
    syncToken,
    apiBase: API_BASE,
    mediaBase: MEDIA_BASE,
    roomSlug,
  });

  useMainHotkeys({
    onTogglePause: toggleLocalPause,
    onToggleMute: toggleMute,
    onAdjustVolume: adjustVolume,
    onToggleHotkeys: () => setShowHotkeys((prev) => !prev),
    onToggleHat: roomSlug ? () => setIsHatHidden((prev) => !prev) : undefined,
    onEaster: bumpInteraction,
  });

  if (!isRouteResolved) {
    return <div className="hero-bg min-h-screen text-[var(--theme-text)]" />;
  }

  if (invalidPath) {
    return <NotFoundPanel />;
  }

  if (!roomSlug) {
    return (
      <PageTransition key="rooms">
        <RoomsScreen rooms={rooms} roomsStatus={roomsStatus} onNavigateToRoom={navigateRoom} />
      </PageTransition>
    );
  }

  if (status === "not_found") {
    return null;
  }

  return (
    <PageTransition key={`room-${roomSlug}`}>
      <div className="hero-bg min-h-screen text-[var(--theme-text)]" onClick={bumpInteraction}>
        <BodrickFlyby
          interactionToken={interactionToken}
          storageKey="bodrick_misses"
          disabled={isHatBodrickActive}
          onActiveChange={setIsFlybyActive}
        />
        <div className={`${playerStyles.shell} mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16`}>
          <MainPlayerPanel
            audioRef={audioRef}
            playButtonRef={playButtonRef}
            roomSlug={roomSlug}
            onBack={navigateHome}
            status={status}
            isFlybyActive={isFlybyActive}
            onBodrickActiveChange={setIsHatBodrickActive}
            isPlaying={isPlaying}
            isLocalPaused={isLocalPaused}
            onTogglePause={toggleLocalPause}
            isMuted={isMuted}
            volume={volume}
            isSliderReady={isSliderReady}
            onToggleMute={toggleMute}
            onVolumeChange={onVolumeChange}
          />
        </div>
        {isHydrated && hotkeysReady ? (
          <HotkeysPanel
            title={ui.main.hotkeys.title}
            hideLabel={ui.main.hotkeys.hide}
            onHide={() => setShowHotkeys(false)}
            suppressHydrationWarning
            className="hotkeys-main"
            entries={[
              {
                key: "Space",
                label: isLocalPaused ? ui.main.hotkeys.play : ui.main.hotkeys.playPause,
              },
              {
                key: "M",
                label: isMuted || volume === 0 ? ui.main.hotkeys.muteOn : ui.main.hotkeys.muteOff,
              },
              { key: "← →", label: ui.main.hotkeys.volume },
              { key: "↑ ↓", label: ui.main.hotkeys.volume },
              {
                key: "B",
                label: isHatHidden ? ui.main.hotkeys.showHat : ui.main.hotkeys.hideHat,
              },
              { key: "H", label: ui.main.hotkeys.hint, isHint: true },
            ]}
          />
        ) : null}
      </div>
    </PageTransition>
  );
}
