/** Snapshot the current profile and live media choices before the client is torn down. */
export function joinChoiceForRetry(state, profile, choice, local) {
  const self = state.participants[state.selfId];
  /** Whether a local source is present and unpaused. */
  const enabled = kind => Boolean(local.has(kind) && !state.producers[local.get(kind)]?.paused);
  return { ...(profile.avatarFile ? { avatarFile: profile.avatarFile } : {}), name: self?.name ?? profile.name, avatar: self?.avatar ?? profile.avatar,
    audio: self ? enabled("audio") : choice.audio, video: self ? enabled("camera") : choice.video };
}
