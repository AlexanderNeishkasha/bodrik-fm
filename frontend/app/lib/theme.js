import { themePreference } from "./themePreference.mjs";

const DEFAULT_THEME = "mono";
/** Supported frontend themes shared with startup and backend contract checks. */
export const THEME_NAMES = Object.freeze([
  "crimson",
  "mono",
  "midnight",
  "ivory",
  "lucifer",
  "aurora",
  "saffron",
  "prism",
  "mythic",
  "grove",
  "spectrum",
  "pirate",
  "emberveil",
]);
const THEMES = new Set(THEME_NAMES);

/** Resolve an arbitrary value to one supported theme name. */
export const normalizeTheme = (value) =>
  THEMES.has(value) ? value : DEFAULT_THEME;

/** Read and normalize the browser's persisted theme when storage is available. */
export const getStoredTheme = () => {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const stored = themePreference("read", null, THEME_NAMES);
    if (!stored) {
      return null;
    }
    return normalizeTheme(stored);
  } catch {
    return null;
  }
};

/** Apply one normalized theme and optionally persist it for later visits. */
export const applyTheme = (theme, options = {}) => {
  const { persist = true } = options;
  if (typeof document === "undefined") {
    return;
  }
  const resolved = normalizeTheme(theme);
  const root = document.documentElement;
  const current = root.getAttribute("data-theme") || DEFAULT_THEME;
  if (current === resolved) {
    if (persist) {
      themePreference("write", resolved, THEME_NAMES);
    }
    return;
  }
  root.classList.add("theme-transition");
  root.setAttribute("data-theme", resolved);
  if (persist) {
    themePreference("write", resolved, THEME_NAMES);
  }
  window.setTimeout(() => {
    root.classList.remove("theme-transition");
  }, 300);
};

/** Return the stable fallback theme used before browser preferences are known. */
export const getDefaultTheme = () => DEFAULT_THEME;
