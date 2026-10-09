import { themePreference } from "../../../app/lib/themePreference.mjs";

/**
 * Player theme names (`app/themes/<name>.css`, `app/lib/theme.js`); the meeting applies
 * the player's own theme CSS. A test keeps this list equal to the theme files.
 */
export const MEETING_THEMES = Object.freeze(["aurora", "crimson", "emberveil", "grove", "ivory", "lucifer", "midnight", "mono", "mythic", "pirate", "prism", "saffron", "spectrum"]);

/** The player's default theme for unknown names. */
const DEFAULT_THEME = "mono";

/** A known player theme name, else the default. */
const normalizeTheme = (value) => (MEETING_THEMES.includes(value) ? value : DEFAULT_THEME);

/** Restore the same validated theme as the pre-hydration script, tolerating blocked storage. */
function storedTheme(storage) {
  try {
    return normalizeTheme(themePreference("read", null, MEETING_THEMES, { storage }));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Remember authoritative room themes for the next refresh without interrupting updates. */
function rememberTheme(storage, theme) {
  try {
    themePreference("write", theme, MEETING_THEMES, { storage });
  } catch {
    // Blocked storage still allows the live room theme to apply.
  }
}

/** Reconnect delay for the public room-state stream. */
const RETRY_MS = 1500;

/**
 * Follow the room's Studio theme over the public room-state WebSocket. The snapshot is
 * the player theme name (unknown names normalize to the player default); the view sets
 * it as `data-theme` so the meeting uses exactly the player's theme tokens.
 */
export function createRoomTheme({ slug, location = globalThis.location, WebSocketImpl = globalThis.WebSocket, setTimer = setTimeout, clearTimer = clearTimeout, storage }) {
  let theme = storedTheme(storage);
  let socket = null;
  let retry = null;
  let stopped = false;
  const listeners = new Set();

  /** Open (or reopen) the stream. */
  function open() {
    if (stopped) return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocketImpl(`${scheme}//${location.host}/ws/rooms/${encodeURIComponent(slug)}/state/public`);
    socket.onmessage = (event) => {
      let value;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof value?.theme !== "string" || normalizeTheme(value.theme) !== value.theme) return;
      rememberTheme(storage, value.theme);
      if (value.theme === theme) return;
      theme = value.theme;
      for (const listener of [...listeners]) listener();
    };
    socket.onclose = () => {
      socket = null;
      if (!stopped) retry = setTimer(open, RETRY_MS);
    };
    socket.onerror = () => socket?.close();
  }

  return {
    /** Current player theme name. */
    getSnapshot: () => theme,
    subscribe(listener) {
      if (!socket && !stopped) open();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Close the stream for good. */
    stop() {
      stopped = true;
      clearTimer(retry);
      socket?.close();
    },
  };
}
