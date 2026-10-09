import { useEffect, useRef, useState } from "react";
import useAudioPulse from "../../lib/useAudioPulse";
import useStudioAudioSync from "./useStudioAudioSync";
import useStudioAudioUnlock from "./useStudioAudioUnlock";
import useStudioAudioVolumeControls from "./useStudioAudioVolumeControls";
import useStudioAutoplayPolicy from "./useStudioAutoplayPolicy";
import useStudioVolumeState from "./useStudioVolumeState";

/** Compose Studio audio element, autoplay, volume, unlock and snapshot synchronization. */
export default function useStudioAudio({
  apiBase,
  mediaBase,
  state,
  isAuthed,
  forceMuted = false,
}) {
  const audioRef = useRef(null);
  const [seekValue, setSeekValue] = useState("0");
  const isSeekingRef = useRef(false);
  const {
    localVolume,
    setLocalVolume,
    localMuted,
    setLocalMuted,
    lastVolumeRef,
    animateVolume,
  } = useStudioVolumeState();
  const hlsRef = useRef(null);
  const lastTrackRef = useRef(null);
  const lastPositionRef = useRef(null);
  const lastIsPlayingRef = useRef(null);
  const lastSyncTokenRef = useRef(null);

  const hasAutoplayPermission = useStudioAutoplayPolicy({
    audioRef,
    isAuthed,
    isPlaying: state?.is_playing,
    localMuted,
    localVolume,
    setLocalMuted,
    setLocalVolume,
    lastVolumeRef,
  });
  useAudioPulse(audioRef, { enabled: true, unlocked: hasAutoplayPermission === true });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = Math.min(1, Math.max(0, localVolume));
    audio.muted = localMuted || forceMuted;
  }, [forceMuted, localMuted, localVolume]);

  const {
    needsUnlock,
    setNeedsUnlock,
    requestPlay,
    unlockAudio,
  } = useStudioAudioUnlock({
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
  });

  const { toggleLocalMute, onLocalVolumeChange, changeLocalVolume } =
    useStudioAudioVolumeControls({
      state,
      localVolume,
      localMuted,
      setLocalVolume,
      setLocalMuted,
      lastVolumeRef,
      needsUnlock,
      unlockAudio,
      requestPlay,
      animateVolume,
    });

  useStudioAudioSync({
    apiBase,
    mediaBase,
    state,
    isAuthed,
    audioRef,
    hlsRef,
    lastTrackRef,
    localMuted: localMuted || forceMuted,
    localVolume,
    requestPlay,
    setNeedsUnlock,
    isSeekingRef,
    setSeekValue,
    lastPositionRef,
    lastIsPlayingRef,
    lastSyncTokenRef,
  });

  return {
    audioRef,
    seekValue,
    setSeekValue,
    isSeekingRef,
    localVolume,
    localMuted: localMuted || forceMuted,
    outputForcedMuted: forceMuted,
    toggleLocalMute,
    onLocalVolumeChange,
    changeLocalVolume,
    unlockAudio,
  };
}
