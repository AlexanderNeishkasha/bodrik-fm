import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredValue, setStoredValue } from "../../lib/storageKeys";

export default function useStudioVolumeState() {
  const autoMutedKey = "admin_auto_muted";
  const [localVolume, setLocalVolume] = useState(() => {
    if (typeof window === "undefined") {
      return 0.8;
    }
    try {
      const stored = getStoredValue("admin_volume");
      if (stored != null) {
        const parsed = Number(stored);
        if (!Number.isNaN(parsed)) {
          return Math.min(1, Math.max(0, parsed));
        }
      }
    } catch {}
    return 0.8;
  });
  const [localMuted, setLocalMuted] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return getStoredValue("admin_muted") === "true";
    } catch {}
    return false;
  });
  const volumeAnimRef = useRef(null);
  const lastVolumeRef = useRef(0.8);

  useEffect(() => {
    const timeout = setTimeout(() => {
      try {
        if (getStoredValue(autoMutedKey) === "true") {
          return;
        }
        setStoredValue("admin_volume", String(localVolume));
      } catch {}
    }, 250);
    return () => clearTimeout(timeout);
  }, [localVolume]);

  useEffect(() => {
    try {
      if (getStoredValue(autoMutedKey) === "true") {
        return;
      }
      setStoredValue("admin_muted", String(localMuted));
    } catch {}
  }, [localMuted]);

  const animateVolume = useCallback((target) => {
    if (volumeAnimRef.current) {
      cancelAnimationFrame(volumeAnimRef.current);
    }
    const start = localVolume;
    const duration = 80;
    const startAt = performance.now();
    const tick = (now) => {
      const elapsed = now - startAt;
      const progress = Math.min(elapsed / duration, 1);
      const raw = start + (target - start) * progress;
      const next = Math.min(1, Math.max(0, raw));
      setLocalVolume(next);
      if (progress < 1) {
        volumeAnimRef.current = requestAnimationFrame(tick);
      } else {
        volumeAnimRef.current = null;
      }
    };
    volumeAnimRef.current = requestAnimationFrame(tick);
  }, [localVolume]);

  return {
    localVolume,
    setLocalVolume,
    localMuted,
    setLocalMuted,
    lastVolumeRef,
    animateVolume,
  };
}
