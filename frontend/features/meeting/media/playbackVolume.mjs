/** Effective element volume: your slider × master volume, and × Studio volume for the music bot. */
export function playbackVolume(participantId, volumes, masterVolume, musicVolume) {
  const studio = participantId === "bodrik-music" ? Math.min(1, Math.max(0, musicVolume)) : 1;
  return Math.min(1, Math.max(0, ((volumes[participantId] ?? 100) / 100) * (masterVolume / 100) * studio));
}
