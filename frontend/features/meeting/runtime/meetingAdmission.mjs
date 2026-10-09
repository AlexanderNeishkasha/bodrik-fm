const ERROR_BY_STATUS = new Map([
  [400, "malformed"],
  [404, "unavailable"],
  [410, "revoked"],
  [429, "rate_limited"],
]);

/** Resolve one canonical public invitation without starting signaling or media. */
export async function resolveMeetingInvitation({ slug, fetchImpl = fetch, signal } = {}) {
  if (typeof slug !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(slug)) {
    return Object.freeze({ phase: "error", code: "malformed", slug: null });
  }
  try {
    const response = await fetchImpl(`/api/rooms/${encodeURIComponent(slug)}/conference`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      return Object.freeze({
        phase: "error",
        code: response.status >= 500 ? "network" : ERROR_BY_STATUS.get(response.status) || "unavailable",
        slug: null,
      });
    }
    const value = await response.json();
    if (!value || value.enabled !== true) {
      return Object.freeze({ phase: "error", code: "disabled", slug: null });
    }
    return Object.freeze({ phase: "prejoin", code: null, slug });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return Object.freeze({ phase: "error", code: "network", slug: null });
  }
}
