/** Meeting gain is active only while the authoritative room meeting is enabled. */
export function isConferenceMusicActive(state) {
  return state?.conference_enabled === true && state?.music_output === "conference";
}

/** Route the shared slider to meeting gain or local Studio volume without changing either preference. */
export function meetingVolumeControls({ state, conference, localVolume, localMuted, toggleLocalMute, onLocalVolumeChange }) {
  const meetingActive = isConferenceMusicActive(state);
  if (!meetingActive) {
    return {
      localVolume,
      localMuted,
      musicOutput: "studio",
      onToggleMute: toggleLocalMute,
      onVolumeChange: onLocalVolumeChange,
    };
  }
  const volume = Number(conference?.musicVolume ?? state?.conference_music_volume ?? 1);
  return {
    localVolume: volume,
    localMuted: volume === 0,
    musicOutput: "conference",
    onToggleMute: () => conference?.setMusicVolume(volume > 0 ? 0 : 1),
    onVolumeChange: (event) => conference?.setMusicVolume(Number(event.target.value)),
  };
}
