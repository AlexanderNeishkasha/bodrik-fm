/** Convert an arbitrary finite nonnegative value or use a safe fallback. */
function nonnegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/** Normalize an untrusted public room snapshot before it reaches playback state. */
export function normalizePublicStatePayload(data) {
  const payload = data && typeof data === "object" ? data : {};
  const mediaPath = typeof payload.current?.media_path === "string"
    ? payload.current.media_path.trim()
    : "";
  const filename = typeof payload.current?.filename === "string"
    ? payload.current.filename.trim()
    : "";
  const syncToken = nonnegativeNumber(payload.sync_token);
  return {
    roomSlug: typeof payload.room_slug === "string" ? payload.room_slug.trim() : "",
    currentTrack: mediaPath || filename || null,
    isPlaying: payload.is_playing === true,
    position: nonnegativeNumber(payload.position),
    syncToken: Number.isSafeInteger(syncToken) ? syncToken : 0,
    theme: typeof payload.theme === "string" ? payload.theme.trim() : "",
  };
}
