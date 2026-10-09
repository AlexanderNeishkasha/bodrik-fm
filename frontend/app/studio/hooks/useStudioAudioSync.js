import { useEffect, useRef } from "react";
import { attachMediaSource, destroyHls } from "../../lib/hls.mjs";

/** Synchronize local media and retire obsolete metadata callbacks on every source change. */
export default function useStudioAudioSync({
  apiBase,
  mediaBase,
  state,
  isAuthed,
  audioRef,
  hlsRef,
  lastTrackRef,
  localMuted,
  localVolume,
  requestPlay,
  setNeedsUnlock,
  isSeekingRef,
  setSeekValue,
  lastPositionRef,
  lastIsPlayingRef,
  lastSyncTokenRef,
}) {
  const metadataHandlerRef = useRef(null);
  const mediaReadyRef = useRef(false);
  const playbackRef = useRef({
    position: state?.position,
    isPlaying: state?.is_playing,
    localMuted,
    localVolume,
  });

  useEffect(() => {
    playbackRef.current = {
      position: state?.position,
      isPlaying: state?.is_playing,
      localMuted,
      localVolume,
    };
  }, [localMuted, localVolume, state?.is_playing, state?.position]);

  useEffect(() => {
    return () => {
      const pending = metadataHandlerRef.current;
      if (pending) pending.audio.removeEventListener("loadedmetadata", pending.handler);
      metadataHandlerRef.current = null;
      destroyHls(hlsRef);
    };
  }, [hlsRef]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const current = state?.current?.media_path || state?.current?.filename;
    if (!current) {
      const pending = metadataHandlerRef.current;
      if (pending) pending.audio.removeEventListener("loadedmetadata", pending.handler);
      metadataHandlerRef.current = null;
      mediaReadyRef.current = false;
      audio.pause();
      destroyHls(hlsRef);
      if (audio.hasAttribute("src") || audio.currentSrc) {
        audio.removeAttribute("src");
        audio.load();
      }
      lastTrackRef.current = null;
      setNeedsUnlock(false);
      return;
    }
    const base = mediaBase || apiBase;
    const attachment = attachMediaSource({
      audio,
      base,
      filename: current,
      hlsRef,
    });
    if (current !== lastTrackRef.current) {
      const previous = metadataHandlerRef.current;
      if (previous) previous.audio.removeEventListener("loadedmetadata", previous.handler);
      lastTrackRef.current = current;
      mediaReadyRef.current = false;
      let attachmentReady = false;
      /** Initialize only the current source from the latest Studio snapshot. */
      const onReady = () => {
        if (!attachmentReady || lastTrackRef.current !== current) return;
        const latest = playbackRef.current;
        audio.currentTime = Number(latest.position ?? 0);
        audio.muted = latest.localMuted;
        audio.volume = Math.min(1, Math.max(0, latest.localVolume));
        mediaReadyRef.current = true;
        audio.removeEventListener("loadedmetadata", onReady);
        if (metadataHandlerRef.current?.handler === onReady) metadataHandlerRef.current = null;
        if (audio.dataset.outputBlocked !== "true" && latest.isPlaying) requestPlay();
      };
      metadataHandlerRef.current = { audio, handler: onReady };
      audio.addEventListener("loadedmetadata", onReady);
      void attachment.then((url) => {
        if (!url || lastTrackRef.current !== current) return;
        attachmentReady = true;
        if (audio.readyState >= 1) onReady();
      });
    }
  }, [
    apiBase,
    audioRef,
    hlsRef,
    lastTrackRef,
    localMuted,
    localVolume,
    mediaBase,
    requestPlay,
    setNeedsUnlock,
    state,
  ]);

  useEffect(() => {
    if (!isSeekingRef.current && state?.position != null) {
      setSeekValue(String(Math.floor(state.position)));
    }
  }, [isSeekingRef, setSeekValue, state?.position]);

  useEffect(() => {
    if (!audioRef.current || !mediaReadyRef.current || state?.position == null) {
      if (state?.position != null) {
        lastPositionRef.current = Number(state.position);
      }
      if (state?.is_playing != null) {
        lastIsPlayingRef.current = Boolean(state.is_playing);
      }
      if (state?.sync_token != null) {
        lastSyncTokenRef.current = Number(state.sync_token);
      }
      return;
    }
    const target = Number(state.position);
    const lastPosition = lastPositionRef.current;
    const lastIsPlaying = lastIsPlayingRef.current;
    const lastSyncToken = lastSyncTokenRef.current;
    const isPlaying = Boolean(state.is_playing);
    const syncToken =
      state?.sync_token == null ? null : Number(state.sync_token);
    const jumpedBack = lastPosition != null && target < lastPosition - 1.5;
    const jumpedForward = lastPosition != null && target - lastPosition > 10;
    const shouldCatchUp =
      isPlaying && target - audioRef.current.currentTime > 10;
    if (syncToken != null && lastSyncToken != null && syncToken !== lastSyncToken) {
      audioRef.current.currentTime = target;
    } else if (jumpedBack || jumpedForward || (isPlaying && lastIsPlaying === false)) {
      audioRef.current.currentTime = target;
    } else if (shouldCatchUp) {
      audioRef.current.currentTime = target;
    }
    if (isPlaying) {
      requestPlay();
    } else {
      audioRef.current.pause();
    }
    lastPositionRef.current = target;
    lastIsPlayingRef.current = isPlaying;
    lastSyncTokenRef.current = syncToken;
  }, [
    audioRef,
    lastIsPlayingRef,
    lastPositionRef,
    lastSyncTokenRef,
    localMuted,
    requestPlay,
    state?.is_playing,
    state?.position,
    state?.sync_token,
  ]);

  useEffect(() => {
    if (!audioRef.current || !mediaReadyRef.current || !state?.is_playing) {
      return;
    }
    requestPlay();
  }, [audioRef, localMuted, localVolume, requestPlay, state?.is_playing]);

  useEffect(() => {
    if (!isAuthed || !mediaReadyRef.current || !state?.is_playing) {
      return undefined;
    }
    let rafId = null;
    const ensureAudio = () => {
      if (!audioRef.current) {
        rafId = requestAnimationFrame(ensureAudio);
        return;
      }
      requestPlay();
    };
    rafId = requestAnimationFrame(ensureAudio);
    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [
    audioRef,
    isAuthed,
    localMuted,
    requestPlay,
    state?.current?.filename,
    state?.is_playing,
  ]);

  useEffect(() => {
    if (!isAuthed || !state?.is_playing || localMuted) {
      setNeedsUnlock(false);
    }
  }, [isAuthed, localMuted, setNeedsUnlock, state?.is_playing]);
}
