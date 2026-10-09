import { useEffect, useRef, useState } from "react";
import {
  AUTOPLAY_POLICY,
  getAutoplayPolicy,
  probeAutoplayPermission,
} from "../../lib/autoplayPolicy";
import { deferEffect } from "../../lib/deferEffect";
import { getStoredValue, removeStoredValue, setStoredValue } from "../../lib/storageKeys";

const AUTO_MUTED_KEY = "admin_auto_muted";
const AUTO_VOLUME_KEY = "admin_auto_volume";
const AUTO_MUTED_VALUE_KEY = "admin_auto_muted_value";

/** Own Studio autoplay probing and temporary volume restoration. */
export default function useStudioAutoplayPolicy({
  audioRef,
  isAuthed,
  isPlaying,
  localMuted,
  localVolume,
  setLocalMuted,
  setLocalVolume,
  lastVolumeRef,
}) {
  const [hasAutoplayPermission, setHasAutoplayPermission] = useState(null);
  const autoMutedRef = useRef(false);
  const initialPlaybackCheckedRef = useRef(false);
  const restoredFromStorageRef = useRef(false);

  /** Remove temporary autoplay restoration hints. */
  const clearAutoMutedFlag = () => {
    if (typeof window === "undefined") return;
    try {
      removeStoredValue(AUTO_MUTED_KEY);
      removeStoredValue(AUTO_VOLUME_KEY);
      removeStoredValue(AUTO_MUTED_VALUE_KEY);
    } catch {}
  };

  useEffect(() => {
    if (typeof navigator === "undefined") {
      return deferEffect(() => setHasAutoplayPermission(false));
    }
    if (!isPlaying) return;
    let cancelled = false;
    let rafId = null;
    let metadataHandler = null;
    let metadataAudio = null;

    /** Resolve a synchronous browser autoplay policy when available. */
    const resolveFromPolicy = ({ defer = false } = {}) => {
      if (cancelled) return false;
      const policy = getAutoplayPolicy(audioRef.current);
      const updatePermission = (value) => {
        if (defer) {
          queueMicrotask(() => {
            if (!cancelled) setHasAutoplayPermission(value);
          });
        } else {
          setHasAutoplayPermission(value);
        }
      };
      if (policy === AUTOPLAY_POLICY.ALLOWED) {
        updatePermission(true);
        return true;
      }
      if (policy !== AUTOPLAY_POLICY.UNKNOWN) {
        updatePermission(false);
        return true;
      }
      return false;
    };

    /** Probe autoplay only after the audio element and metadata are ready. */
    const resolveWithProbe = () => {
      if (cancelled || hasAutoplayPermission != null) return;
      if (!audioRef.current) {
        rafId = requestAnimationFrame(resolveWithProbe);
        return;
      }
      if (audioRef.current.readyState < 1) {
        if (!metadataHandler) {
          metadataHandler = () => {
            metadataHandler = null;
            metadataAudio = null;
            resolveWithProbe();
          };
          metadataAudio = audioRef.current;
          metadataAudio.addEventListener("loadedmetadata", metadataHandler, { once: true });
        }
        return;
      }
      probeAutoplayPermission(audioRef.current).then((result) => {
        if (!cancelled && result != null) setHasAutoplayPermission(result);
      });
    };

    if (!resolveFromPolicy({ defer: true })) resolveWithProbe();
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (metadataHandler && metadataAudio) {
        metadataAudio.removeEventListener("loadedmetadata", metadataHandler);
      }
    };
  }, [audioRef, hasAutoplayPermission, isPlaying]);

  useEffect(() => {
    if (!localMuted) clearAutoMutedFlag();
  }, [localMuted]);

  useEffect(() => {
    if (!isAuthed) {
      autoMutedRef.current = false;
      initialPlaybackCheckedRef.current = false;
      restoredFromStorageRef.current = false;
      return;
    }
    if (!initialPlaybackCheckedRef.current && isPlaying != null) {
      if (hasAutoplayPermission == null) return;
      initialPlaybackCheckedRef.current = true;
      if (!isPlaying || hasAutoplayPermission) {
        autoMutedRef.current = true;
        return;
      }
    }
    if (!isPlaying || autoMutedRef.current) return;
    autoMutedRef.current = true;
    try {
      if (getStoredValue(AUTO_MUTED_KEY) !== "true") {
        setStoredValue(AUTO_VOLUME_KEY, String(localVolume));
        setStoredValue(AUTO_MUTED_VALUE_KEY, String(localMuted));
      }
      setStoredValue(AUTO_MUTED_KEY, "true");
    } catch {}
    if (!localMuted) setLocalMuted(true);
    if (localVolume > 0) {
      lastVolumeRef.current = localVolume;
      setLocalVolume(0);
    }
  }, [
    hasAutoplayPermission,
    isAuthed,
    isPlaying,
    lastVolumeRef,
    localMuted,
    localVolume,
    setLocalMuted,
    setLocalVolume,
  ]);

  useEffect(() => {
    if (isPlaying && hasAutoplayPermission == null) {
      return deferEffect(() => {
        const policy = getAutoplayPolicy(audioRef.current);
        if (policy === AUTOPLAY_POLICY.ALLOWED) setHasAutoplayPermission(true);
        else if (policy !== AUTOPLAY_POLICY.UNKNOWN) setHasAutoplayPermission(false);
      });
    }
    return undefined;
  }, [audioRef, hasAutoplayPermission, isPlaying]);

  useEffect(() => {
    if (!hasAutoplayPermission || !isPlaying || typeof window === "undefined") return;
    if (restoredFromStorageRef.current) return;
    restoredFromStorageRef.current = true;
    let restoreVolume = null;
    let restoreMuted = null;
    try {
      const hadAutoMutedKey = getStoredValue(AUTO_MUTED_KEY) === "true";
      const storedAutoVolume = getStoredValue(AUTO_VOLUME_KEY);
      const storedAutoMuted = getStoredValue(AUTO_MUTED_VALUE_KEY);
      const useAutoValues = hadAutoMutedKey || storedAutoVolume != null || storedAutoMuted != null;
      const storedVolume = useAutoValues ? storedAutoVolume : getStoredValue("admin_volume");
      const storedMuted = useAutoValues ? storedAutoMuted : getStoredValue("admin_muted");
      restoreVolume = storedVolume == null ? null : Number(storedVolume);
      restoreMuted = storedMuted == null ? null : storedMuted === "true";
      if (hadAutoMutedKey) clearAutoMutedFlag();
    } catch {}
    if (restoreMuted != null) setLocalMuted(restoreMuted);
    if (restoreVolume != null && Number.isFinite(restoreVolume)) {
      setLocalVolume(Math.min(1, Math.max(0, restoreVolume)));
    }
  }, [hasAutoplayPermission, isPlaying, setLocalMuted, setLocalVolume]);

  return hasAutoplayPermission;
}
