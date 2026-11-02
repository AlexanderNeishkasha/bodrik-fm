/** Prefix of the meeting host in front of the player host (meet.bodrik.fm, meet.bodrik.lan). */
const MEETING_HOST_PREFIX = "meet.";

/**
 * Player origin for status-page links: production's bodrik.fm; in development the current
 * host without its meeting prefix (meet.bodrik.lan → bodrik.lan), else same origin ("").
 */
export function playerOrigin(location, production = process.env.NODE_ENV === "production") {
  if (production) return "https://bodrik.fm";
  if (!location?.hostname?.startsWith(MEETING_HOST_PREFIX)) return "";
  return `${location.protocol}//${location.host.slice(MEETING_HOST_PREFIX.length)}`;
}

/** Resolve player destinations independently of the meeting document's origin. */
export function statusPageHref(href, origin = playerOrigin(globalThis.location)) {
  return href === "/" || href === "/studio" ? `${origin}${href}` : href;
}
