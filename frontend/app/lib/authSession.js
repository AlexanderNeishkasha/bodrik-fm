const AUTH_USER_KEY = "bodrik_fm_auth_user";

/** Read a browser-only auth hint; SSR and unavailable storage have no cached user. */
export function getCachedAuthUser() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(AUTH_USER_KEY);
    if (!raw) {
      return null;
    }
    const payload = JSON.parse(raw);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function hasCachedAuthUser() {
  return getCachedAuthUser() != null;
}

export function getCachedAuthRole() {
  const user = getCachedAuthUser();
  return user?.actor_role ?? user?.role ?? null;
}

/** Cache the browser's auth hint; never access Node's server-side Web Storage. */
export function setCachedAuthUser(user) {
  if (typeof window === "undefined" || !user || typeof user !== "object") {
    return;
  }
  window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

/** Remove the browser's auth hint without touching server-side storage during SSR. */
export function clearCachedAuthUser() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(AUTH_USER_KEY);
  }
}
