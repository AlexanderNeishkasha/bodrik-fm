import { useCallback, useEffect, useRef, useState } from "react";
import { attachMediaSource, destroyHls } from "./hls.mjs";
import usePublicAudioResume from "./usePublicAudioResume";
import usePublicMediaSession from "./usePublicMediaSession";

/** Keep one public audio element aligned with authoritative room playback. */
export default function usePublicAudioSync({
  audioRef,
  hlsRef,
  currentTrack,
  isPlaying,
  position,
  syncToken,
  apiBase,
  mediaBase,
  roomSlug,
}) {
  const [isLocalPaused, setIsLocalPaused] = useState(true);
  const lastPositionRef = useRef(null);
  const lastIsPlayingRef = useRef(null);
  const lastSyncTokenRef = useRef(null);
  const lastTrackRef = useRef(null);
  const pendingUserSyncRef = useRef({ active: false, position: null });
  const ignoredPauseEventsRef = useRef(0);
  const userPausedRef = useRef(false);
  const metadataHandlerRef = useRef(null);
  const mediaReadyRef = useRef(false);
  const playbackRef = useRef({ position, isPlaying, syncToken });

  useEffect(() => {
    playbackRef.current = { position, isPlaying, syncToken };
  }, [isPlaying, position, syncToken]);

  /** Notify the shared visualizer after successful user-authorized playback. */
  const unlockPulse = useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("bodrik_fm_audio_pulse_unlock"));
    }
  }, []);

  /** Pause without treating the resulting media event as an explicit user pause. */
  const pauseForSync = useCallback((audio) => {
    if (!audio || audio.paused) {
      return;
    }
    ignoredPauseEventsRef.current += 1;
    audio.pause();
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        if (ignoredPauseEventsRef.current > 0) {
          ignoredPauseEventsRef.current -= 1;
        }
      }, 1000);
    }
  }, []);

  const resumeFromFreshPosition = usePublicAudioResume({
    audioRef,
    apiBase,
    roomSlug,
    currentTrack,
    position,
    pendingUserSyncRef,
    userPausedRef,
    setIsLocalPaused,
    unlockPulse,
  });

  useEffect(() => {
    return () => {
      const pending = metadataHandlerRef.current;
      if (pending) pending.audio.removeEventListener("loadedmetadata", pending.handler);
      metadataHandlerRef.current = null;
      mediaReadyRef.current = false;
      lastTrackRef.current = null;
      destroyHls(hlsRef);
    };
  }, [currentTrack, hlsRef, roomSlug]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const onPause = () => {
      if (ignoredPauseEventsRef.current > 0) {
        ignoredPauseEventsRef.current -= 1;
        return;
      }
      userPausedRef.current = true;
      setIsLocalPaused(true);
    };
    const onPlay = () => {
      userPausedRef.current = false;
      setIsLocalPaused(false);
      unlockPulse();
    };

    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    return () => {
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("play", onPlay);
    };
  }, [audioRef, unlockPulse]);

  usePublicMediaSession({
    audioRef,
    isPlaying,
    resumeFromFreshPosition,
    userPausedRef,
    setIsLocalPaused,
  });

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    const audio = audioRef.current;
    if (!currentTrack) {
      const pending = metadataHandlerRef.current;
      if (pending) pending.audio.removeEventListener("loadedmetadata", pending.handler);
      metadataHandlerRef.current = null;
      mediaReadyRef.current = false;
      pauseForSync(audio);
      audio.removeAttribute("src");
      destroyHls(hlsRef);
      lastTrackRef.current = null;
      return;
    }

    /** Attempt playback only while the current user has not paused locally. */
    const attemptAutoplay = async () => {
      if (!playbackRef.current.isPlaying || userPausedRef.current) {
        return;
      }
      setIsLocalPaused(false);
      try {
        await audio.play();
        userPausedRef.current = false;
        setIsLocalPaused(false);
        unlockPulse();
      } catch {
        userPausedRef.current = true;
        setIsLocalPaused(true);
      }
    };

    /** Apply revision/jump drift policy to an already-ready current media source. */
    const applySync = ({ forcePlay = false } = {}) => {
      const target = Number(position || 0);
      const lastPosition = lastPositionRef.current;
      const lastIsPlaying = lastIsPlayingRef.current;
      const lastSyncToken = lastSyncTokenRef.current;
      const jumpedBack = lastPosition != null && target < lastPosition - 1.5;
      const jumpedForward = lastPosition != null && target - lastPosition > 10;
      const shouldCatchUp = isPlaying && target - audio.currentTime > 10;

      if (pendingUserSyncRef.current.active && isPlaying) {
        const forced = pendingUserSyncRef.current.position != null ? pendingUserSyncRef.current.position : target;
        pendingUserSyncRef.current = { active: false, position: null };
        audio.currentTime = forced;
      } else if (lastSyncToken != null && syncToken !== lastSyncToken) {
        audio.currentTime = target;
      } else if (jumpedBack || jumpedForward || (isPlaying && lastIsPlaying === false)) {
        audio.currentTime = target;
      } else if (shouldCatchUp) {
        audio.currentTime = target;
      }

      if (!isPlaying) {
        pauseForSync(audio);
      } else if ((forcePlay && !userPausedRef.current) || !isLocalPaused) {
        audio
          .play()
          .then(() => {
            userPausedRef.current = false;
            setIsLocalPaused(false);
            unlockPulse();
          })
          .catch(() => {
            userPausedRef.current = true;
            setIsLocalPaused(true);
          });
      } else {
        pauseForSync(audio);
      }

      lastPositionRef.current = target;
      lastIsPlayingRef.current = isPlaying;
      lastSyncTokenRef.current = syncToken;
    };

    const attachment = attachMediaSource({
      audio,
      base: mediaBase || apiBase,
      filename: currentTrack,
      hlsRef,
    });
    const isNewTrack = currentTrack !== lastTrackRef.current;
    if (isNewTrack) {
      const previous = metadataHandlerRef.current;
      if (previous) previous.audio.removeEventListener("loadedmetadata", previous.handler);
      lastTrackRef.current = currentTrack;
      mediaReadyRef.current = false;
      let attachmentReady = false;
      /** Initialize the new source only after its own async attachment is current. */
      const onReady = () => {
        if (!attachmentReady || lastTrackRef.current !== currentTrack) return;
        const latest = playbackRef.current;
        const pending = pendingUserSyncRef.current;
        const target = pending.active && latest.isPlaying && pending.position != null
          ? pending.position
          : Number(latest.position || 0);
        pendingUserSyncRef.current = { active: false, position: null };
        audio.currentTime = target;
        mediaReadyRef.current = true;
        lastPositionRef.current = target;
        lastIsPlayingRef.current = latest.isPlaying;
        lastSyncTokenRef.current = latest.syncToken;
        attemptAutoplay();
        audio.removeEventListener("loadedmetadata", onReady);
        if (metadataHandlerRef.current?.handler === onReady) metadataHandlerRef.current = null;
      };
      metadataHandlerRef.current = { audio, handler: onReady };
      audio.addEventListener("loadedmetadata", onReady);
      void attachment.then((url) => {
        if (!url || lastTrackRef.current !== currentTrack) return;
        attachmentReady = true;
        if (audio.readyState >= 1) onReady();
      });
      return;
    }

    if (mediaReadyRef.current) applySync();
  }, [apiBase, audioRef, currentTrack, hlsRef, isLocalPaused, isPlaying, mediaBase, pauseForSync, position, roomSlug, syncToken, unlockPulse]);

  /** Toggle listener-local pause without changing authoritative room playback. */
  const toggleLocalPause = async () => {
    if (!audioRef.current) {
      return;
    }
    if (audioRef.current.paused) {
      if (!isPlaying) {
        setIsLocalPaused((prev) => {
          const next = !prev;
          userPausedRef.current = next;
          pendingUserSyncRef.current = next ? { active: false, position: null } : { active: true, position: null };
          return next;
        });
        return;
      }
      await resumeFromFreshPosition();
    } else {
      userPausedRef.current = true;
      audioRef.current.pause();
      setIsLocalPaused(true);
    }
  };

  return { isLocalPaused, toggleLocalPause };
}
