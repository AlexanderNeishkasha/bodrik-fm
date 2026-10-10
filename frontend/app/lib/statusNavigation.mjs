/** Resolve player destinations independently of the meeting document's origin. */
export function statusPageHref(href, playerOrigin = process.env.NODE_ENV === "production" ? "https://bodrik.fm" : "") {
  return href === "/" || href === "/studio" ? `${playerOrigin}${href}` : href;
}
