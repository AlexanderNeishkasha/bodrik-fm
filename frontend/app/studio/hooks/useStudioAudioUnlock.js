import { useEffect, useRef, useState } from "react";
import { attachMediaSource, getDirectUrl, getHlsUrl } from "../../lib/hls.mjs";
import { deferEffect } from "../../lib/deferEffect";

/** Attempt local playback only while the element's current output gate allows it. */
export default function useStudioAudioUnlock({
  apiBase,
  mediaBase,
  audioRef,
  state,
  isAuthed,
  localMuted,
  localVolume,
  forceMuted,
  setLocalMuted,
  setLocalVolume,
  lastVolumeRef,
  hlsRef,
}) {
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const pendingUnlockRef = useRef(null);
  useEffect(
    () => () => pendingUnlockRef.current?.(),
    [isAuthed, state?.current?.filename, state?.current?.media_path],
  );

  useEffect(() => {
    if (!isAuthed) {
      return deferEffect(() => setNeedsUnlock(false));
    }
    return undefined;
  }, [isAuthed]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.autoplay = Boolean(state?.is_playing) && !needsUnlock;
    if (needsUnlock) {
      audioRef.current.pause();
    }
  }, [needsUnlock, audioRef, state?.is_playing]);

  /** Ignore stale unlock attempts after output changed or Studio was unmounted. */
  const requestPlay = (options = {}) => {
    if (audioRef.current?.dataset.outputBlocked === "true") return Promise.resolve();
    if (!audioRef.current) {
      if (options.force) {
        setNeedsUnlock(true);
      }
      return Promise.resolve();
    }
    if (options.force) {
      setNeedsUnlock(false);
    }
    return audioRef.current
      .play()
      .then(() => {
        setNeedsUnlock(false);
      })
      .catch(() => {
        setNeedsUnlock(true);
      });
  };

  /** Ensure source attachment has started and report whether its metadata is current. */
  const ensureSource = () => {
    const audio = audioRef.current;
    if (!audio || audio.dataset.outputBlocked === "true") return null;
    const current = state?.current?.media_path || state?.current?.filename;
    if (!current) return null;
    const base = mediaBase || apiBase;
    const source = audio.currentSrc || audio.src;
    const directUrl = getDirectUrl(base, current);
    const hlsUrl = getHlsUrl(base, current);
    const sourceIsCurrent = source === directUrl || source === hlsUrl || hlsRef.current?.__meetingFmUrl === hlsUrl;
    if (!sourceIsCurrent) {
      void attachMediaSource({ audio, base, filename: current, hlsRef });
    }
    return { audio, ready: sourceIsCurrent && audio.readyState >= 1 };
  };

  /** User-gesture playback; pending metadata waits are cancelled on source change. */
  const unlockAudio = (options = {}) => {
    const source = ensureSource();
    if (!source) return Promise.resolve();
    const { audio } = source;
    const shouldUnmute = Boolean(options.unmute);
    const nextVolume =
      typeof options.volume === "number"
        ? Math.min(1, Math.max(0, options.volume))
        : null;
    if (state?.position != null) {
      audio.currentTime = Number(state.position);
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("bodrik_fm_audio_pulse_unlock"));
    }
    if (shouldUnmute) {
      setLocalMuted(false);
      audio.muted = forceMuted;
    }
    if (nextVolume != null) {
      if (nextVolume > 0) {
        lastVolumeRef.current = nextVolume;
      }
      setLocalVolume(nextVolume);
      audio.volume = nextVolume;
    } else if (localVolume === 0 && shouldUnmute) {
      const next = lastVolumeRef.current || 0.8;
      setLocalVolume(next);
      audio.volume = Math.min(1, Math.max(0, next));
    }
    setNeedsUnlock(false);
    if (source.ready) return requestPlay({ force: true });
    pendingUnlockRef.current?.();
    return new Promise((resolve) => {
      const onReady = () => {
        audio.removeEventListener("loadedmetadata", onReady);
        pendingUnlockRef.current = null;
        requestPlay({ force: true }).finally(resolve);
      };
      pendingUnlockRef.current = () => {
        audio.removeEventListener("loadedmetadata", onReady);
        pendingUnlockRef.current = null;
        resolve();
      };
      audio.addEventListener("loadedmetadata", onReady);
    });
  };

  return {
    needsUnlock,
    setNeedsUnlock,
    requestPlay,
    unlockAudio,
  };
}
