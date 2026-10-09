import { useCallback, useEffect, useRef } from "react";

/** Resume local public audio from a freshly authorized room position. */
export default function usePublicAudioResume({
  audioRef,
  apiBase,
  roomSlug,
  currentTrack,
  position,
  pendingUserSyncRef,
  userPausedRef,
  setIsLocalPaused,
  unlockPulse,
}) {
  const controllerRef = useRef(null);
  const metadataRef = useRef(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      const pending = metadataRef.current;
      if (pending) pending.audio.removeEventListener("loadedmetadata", pending.handler);
      metadataRef.current = null;
    };
  }, [currentTrack, roomSlug]);

  /** Read a fresh position before a local resume rather than trusting a stale event. */
  const fetchFreshPosition = useCallback(async (signal) => {
    try {
      if (!roomSlug) return null;
      const encodedSlug = encodeURIComponent(roomSlug);
      const response = await fetch(`${apiBase}/api/rooms/${encodedSlug}/state/public`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data?.position === "number" && Number.isFinite(data.position)
        ? Math.max(0, data.position)
        : null;
    } catch {
      return null;
    }
  }, [apiBase, roomSlug]);

  return useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    pendingUserSyncRef.current = { active: true, position: null };
    const freshPosition = await fetchFreshPosition(controller.signal);
    if (controller.signal.aborted) return;
    const seekTo = freshPosition ?? Number(position || 0);
    pendingUserSyncRef.current = { active: true, position: seekTo };

    if (audio.readyState >= 1) {
      audio.currentTime = seekTo;
    } else {
      const previous = metadataRef.current;
      if (previous) previous.audio.removeEventListener("loadedmetadata", previous.handler);
      /** Apply the fresh seek after the current source exposes metadata. */
      const onReady = () => {
        audio.currentTime = seekTo;
        audio.removeEventListener("loadedmetadata", onReady);
        if (metadataRef.current?.handler === onReady) metadataRef.current = null;
      };
      metadataRef.current = { audio, handler: onReady };
      audio.addEventListener("loadedmetadata", onReady);
    }

    try {
      await audio.play();
      if (controller.signal.aborted) return;
      userPausedRef.current = false;
      setIsLocalPaused(false);
      unlockPulse();
    } catch {
      if (!controller.signal.aborted) {
        userPausedRef.current = true;
        setIsLocalPaused(true);
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [audioRef, fetchFreshPosition, pendingUserSyncRef, position, setIsLocalPaused, unlockPulse, userPausedRef]);
}
