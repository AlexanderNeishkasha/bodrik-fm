const PREFIX = "bodrik_fm_";

export const storageKey = (name) => `${PREFIX}${name}`;

/** Read browser preferences; server rendering has no local storage. */
export const getStoredValue = (name) => {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(storageKey(name));
};

/** Persist a browser preference, never process-wide Node Web Storage. */
export const setStoredValue = (name, value) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(name), value);
};

/** Remove a browser preference; no-op during server rendering. */
export const removeStoredValue = (name) => {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(storageKey(name));
};
