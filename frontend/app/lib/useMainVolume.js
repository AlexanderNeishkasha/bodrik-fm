import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredValue, setStoredValue } from "./storageKeys";

function initialVolume() {
  try {
    const storedVolume = getStoredValue("volume");
    if (storedVolume != null) {
      const parsed = Number(storedVolume);
      if (!Number.isNaN(parsed)) {
        return Math.min(1, Math.max(0, parsed));
      }
    }
  } catch {}
  return 0.8;
}

function initialMuted() {
  try {
    return getStoredValue("muted") === "true";
  } catch {}
  return false;
}

export default function useMainVolume() {
  const [volume, setVolume] = useState(initialVolume);
  const [isMuted, setIsMuted] = useState(initialMuted);
  const isSliderReady = true;
  const volumeRef = useRef(0.8);
  const lastVolumeRef = useRef(0.8);
  const volumeAnimRef = useRef(null);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      try {
        setStoredValue("volume", String(volume));
      } catch {}
    }, 250);
    return () => clearTimeout(timeout);
  }, [volume]);

  useEffect(() => {
    try {
      setStoredValue("muted", String(isMuted));
    } catch {}
  }, [isMuted]);

  const animateVolume = useCallback(
    (target) => {
      if (volumeAnimRef.current) {
        cancelAnimationFrame(volumeAnimRef.current);
      }
      const start = volumeRef.current;
      const duration = 80;
      const startAt = performance.now();
      const tick = (now) => {
        const elapsed = now - startAt;
        const progress = Math.min(elapsed / duration, 1);
        const raw = start + (target - start) * progress;
        const next = Math.min(1, Math.max(0, raw));
        setVolume(next);
        if (progress < 1) {
          volumeAnimRef.current = requestAnimationFrame(tick);
        } else {
          volumeAnimRef.current = null;
        }
      };
      volumeAnimRef.current = requestAnimationFrame(tick);
    },
    []
  );

  const toggleMute = useCallback(() => {
    if (isMuted || volumeRef.current === 0) {
      const next = lastVolumeRef.current || 0.8;
      setIsMuted(false);
      animateVolume(next);
      return;
    }
    if (volumeRef.current > 0) {
      lastVolumeRef.current = volumeRef.current;
    }
    setIsMuted(true);
    animateVolume(0);
  }, [animateVolume, isMuted]);

  const onVolumeChange = useCallback(
    (event) => {
      const next = Number(event.target.value);
      setVolume(next);
      if (next > 0) {
        lastVolumeRef.current = next;
        setIsMuted(false);
      } else {
        setIsMuted(true);
      }
    },
    []
  );

  const adjustVolume = useCallback(
    (delta) => {
      const next = Math.min(1, Math.max(0, volumeRef.current + delta));
      setVolume(next);
      if (next > 0) {
        lastVolumeRef.current = next;
        setIsMuted(false);
      } else {
        setIsMuted(true);
      }
    },
    []
  );

  return {
    volume,
    isMuted,
    isSliderReady,
    toggleMute,
    onVolumeChange,
    adjustVolume,
  };
}
