/** Replacement meeting protocol version spoken by this client. */
export const PROTOCOL_VERSION = 1;

/** Public room slugs accepted by the Rust meeting endpoint. */
const SLUG = /^[A-Za-z0-9_-]{1,128}$/;

/** Canonical uploaded-avatar path accepted by the Rust profile command. */
const AVATAR_PATH = /^\/uploads\/avatars\/[0-9a-f-]{36}\.(?:png|jpg|webp)$/;

/** Return whether a slug can be sent to the meeting endpoint. */
function validSlug(slug) {
  return typeof slug === "string" && SLUG.test(slug);
}

/** Convert the page location into the fixed same-origin meeting WebSocket URL. */
export function meetingEndpoint(slug, location) {
  if (!validSlug(slug)) throw new Error("Invalid meeting slug");
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws/meeting/v1/${encodeURIComponent(slug)}`;
}

/** Generate one random 256-bit owner proof as 64 lowercase hex characters. */
export function createOwnerProof(crypto) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Return the same-origin uploaded-avatar path, or "" for anything else. */
export function profileAvatarPath(value, location) {
  if (!value || typeof value !== "string") return "";
  const origin = `${location.protocol}//${location.host}`;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && AVATAR_PATH.test(url.pathname) ? url.pathname : "";
  } catch {
    return "";
  }
}

/** Shape of a Studio host pass: 64 lowercase hex characters. */
const HOST_GRANT = /^[0-9a-f]{64}$/;

/**
 * Take the Studio host pass from the `#host=` fragment of the meeting link and remove
 * it from the address bar, so it is neither bookmarked nor shared. Returns "" if absent.
 */
export function takeHostGrant(location = globalThis.location, history = globalThis.history) {
  const match = /(?:^#|&)host=([^&]*)/.exec(location?.hash || "");
  if (!match) return "";
  history?.replaceState?.(history.state, "", `${location.pathname}${location.search}`);
  return HOST_GRANT.test(match[1]) ? match[1] : "";
}

/** Request a single-use guest ticket; a host pass (once) makes this browser a room host. */
export async function requestGuestTicket(slug, { fetchImpl = fetch, signal, hostGrant = "" } = {}) {
  const response = await fetchImpl(`/api/rooms/${encodeURIComponent(slug)}/conference/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: hostGrant ? JSON.stringify({ hostGrant }) : "{}",
    cache: "no-store",
    signal: signal || AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Object.assign(new Error(`Meeting ticket failed (${response.status})`), { status: response.status });
  const value = await response.json();
  if (value?.version !== PROTOCOL_VERSION || typeof value.ticket !== "string" || value.roomSlug !== slug) {
    throw new Error("Invalid meeting ticket");
  }
  return value.ticket;
}
