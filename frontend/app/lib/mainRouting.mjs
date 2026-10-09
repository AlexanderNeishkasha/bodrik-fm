const RESERVED_SEGMENTS = new Set([
  "studio",
  "admin",
  "puppet_master",
  "api",
  "ws",
  "media",
  "privacy",
  "terms",
  "bye",
  "meeting-unavailable",
  "download",
  "desktop_releases",
  "404",
  "500",
  "_next",
]);

/** Resolve the SPA fallback pathname into a room route or invalid-path state. */
export function detectRoomPath(pathname) {
  const segments = (pathname || "/").split("/").filter(Boolean);
  if (segments.length === 0) {
    return { roomSlug: null, invalidPath: false };
  }
  if (segments.length !== 1 || RESERVED_SEGMENTS.has(segments[0])) {
    return { roomSlug: null, invalidPath: true };
  }
  try {
    const roomSlug = decodeURIComponent(segments[0]);
    if (!roomSlug || roomSlug.includes("/")) {
      return { roomSlug: null, invalidPath: true };
    }
    return { roomSlug, invalidPath: false };
  } catch {
    return { roomSlug: null, invalidPath: true };
  }
}

/** Read the current browser pathname without making server rendering depend on it. */
export function detectRoomSlug() {
  if (typeof window === "undefined") {
    return { roomSlug: null, invalidPath: false };
  }
  return detectRoomPath(window.location.pathname);
}

/** Encode one room slug as a root-relative browser path. */
export function roomPath(roomSlug) {
  return `/${encodeURIComponent(roomSlug)}`;
}
