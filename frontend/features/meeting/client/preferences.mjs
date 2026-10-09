/** localStorage key for personal meeting preferences. */
const STORAGE_KEY = "meeting.preferences.v1";

/** Defaults and validators for each preference. */
const SPEC = Object.freeze({
  language: { initial: "ru", valid: (value) => value === "ru" || value === "en" },
  shortcuts: { initial: true, valid: (value) => typeof value === "boolean" },
  masterVolume: { initial: 100, valid: (value) => Number.isInteger(value) && value >= 0 && value <= 100 },
});

/** Fixed meeting behavior; saved flags from earlier versions cannot override it. */
export const ROOM_BEHAVIOR = Object.freeze({ sounds: true, shareOnJoin: false, cameraOffParticipants: true, keepControls: true, keepAwake: true });

/** Merge stored values over defaults, dropping invalid ones. */
function parseMeetingPreferences(raw) {
  let stored = {};
  try {
    stored = raw ? JSON.parse(raw) : {};
  } catch {
    stored = {};
  }
  return Object.freeze({ ...ROOM_BEHAVIOR, ...Object.fromEntries(Object.entries(SPEC).map(([key, { initial, valid }]) => [key, valid(stored?.[key]) ? stored[key] : initial])) });
}

/** Personal meeting preferences (language, shortcuts, master speaker volume), persisted locally. */
export function createPreferences({ storage } = {}) {
  let snapshot = parseMeetingPreferences(read(storage));
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Validate, store and publish one preference. */
    set(key, value) {
      if (!SPEC[key]?.valid(value)) throw new Error("Invalid preference");
      if (snapshot[key] === value) return;
      snapshot = Object.freeze({ ...snapshot, [key]: value });
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Blocked storage: keep in memory only.
      }
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Read stored preferences, ignoring unavailable storage. */
function read(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Read the saved language for entry pages that have not created a meeting client yet. */
export function storedMeetingLanguage() {
  try {
    return parseMeetingPreferences(globalThis.localStorage?.getItem(STORAGE_KEY)).language;
  } catch {
    return "ru";
  }
}
