const RESERVED_SLUGS = new Set([
  "api",
  "brand",
  "config",
  "health",
  "internal",
  "join",
  "meeting",
  "privacy",
  "ready",
  "room",
  "uploads",
  "vendor",
  "ws",
]);

const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Decode one public meeting pathname without consulting browser globals. */
export function parseMeetingPath(pathname) {
  if (typeof pathname !== "string") return { slug: null, valid: false };
  const match = /^\/room\/([^/]+)$/.exec(pathname);
  if (!match) return { slug: null, valid: false };
  let slug;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return { slug: null, valid: false };
  }
  if (!SLUG_PATTERN.test(slug) || RESERVED_SLUGS.has(slug.toLowerCase())) {
    return { slug: null, valid: false };
  }
  return { slug, valid: true };
}
