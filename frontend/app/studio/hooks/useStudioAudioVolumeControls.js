export default function useStudioAudioVolumeControls({
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
}) {
  const toggleLocalMute = () => {
    if (localMuted || localVolume === 0) {
      unlockAudio({ unmute: true });
      return;
    }
    if (localVolume > 0) {
      lastVolumeRef.current = localVolume;
    }
    setLocalMuted(true);
    animateVolume(0);
  };

  const onLocalVolumeChange = (event) => {
    const next = Number(event.target.value);
    if (next > 0 && state?.is_playing && needsUnlock) {
      unlockAudio({ volume: next, unmute: true });
      return;
    }
    setLocalVolume(next);
    if (next > 0) {
      lastVolumeRef.current = next;
      setLocalMuted(false);
      if (state?.is_playing) {
        requestPlay({ force: true });
      }
    } else {
      setLocalMuted(true);
    }
  };

  const changeLocalVolume = (delta) => {
    const next = Math.min(1, Math.max(0, localVolume + delta));
    if (next > 0 && state?.is_playing && needsUnlock) {
      unlockAudio({ volume: next, unmute: true });
      return;
    }
    setLocalVolume(next);
    if (next > 0) {
      lastVolumeRef.current = next;
      setLocalMuted(false);
      if (state?.is_playing) {
        requestPlay({ force: true });
      }
    } else {
      setLocalMuted(true);
    }
  };

  return { toggleLocalMute, onLocalVolumeChange, changeLocalVolume };
}
