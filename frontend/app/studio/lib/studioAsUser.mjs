/** Parse a positive integer impersonation target or reject it. */
export function parseStudioAsUserIdValue(raw) {
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/** Read the browser's current impersonation query without server access. */
export function parseStudioAsUserId() {
  if (typeof window === "undefined") {
    return null;
  }
  return parseStudioAsUserIdValue(new URLSearchParams(window.location.search).get("as"));
}

/** Clear impersonation and navigate home only after authoritative logout succeeds. */
export async function logoutAndResetStudioAsUser({ setStudioAsUserId, logout, navigateHome }) {
  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    if (url.searchParams.has("as")) {
      url.searchParams.delete("as");
      const cleanedPath = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState(window.history.state, "", cleanedPath);
    }
  }
  setStudioAsUserId(null);
  const loggedOut = await logout();
  if (loggedOut && typeof navigateHome === "function") navigateHome();
  return loggedOut;
}
