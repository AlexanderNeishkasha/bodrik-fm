/** Retained settings order and IDs; these identify sections, never grant server permissions. */
export const sections = Object.freeze([
  "tabAudioDevices",
  "tabVideoDevices",
  "tabProfile",
  "tabRoom",
  "tabModerator",
  "tabShortcuts",
  "tabLanguages",
]);

/** Own shell navigation only; capability refresh cannot create media or send policy commands. */
export function create({ getAvailableSections, getLanguage }) {
  const listeners = new Set();
  let open = false;
  let selected = null;
  let available = Object.freeze([]);
  let language;
  let snapshot;
  let disposed = false;

  /** Reconcile hidden sections deterministically and cache a stable immutable external-store snapshot. */
  function refresh() {
    if (disposed) return;
    const input = getAvailableSections();
    if (!Array.isArray(input) || input.some((id) => !sections.includes(id)))
      throw new Error("Invalid settings section capabilities");
    const next = sections.filter((id) => input.includes(id));
    if (
      available.length !== next.length ||
      available.some((id, index) => id !== next[index])
    )
      available = Object.freeze(next);
    if (!available.includes(selected)) selected = available[0] || null;
    if (!selected) open = false;
    language = getLanguage() === "en" ? "en" : "ru";
    if (
      snapshot &&
      snapshot.open === open &&
      snapshot.selected === selected &&
      snapshot.available === available &&
      snapshot.language === language
    )
      return;
    snapshot = Object.freeze({ open, selected, available, language });
    listeners.forEach((listener) => listener());
  }
  refresh();
  return {
    /** Read shell UI state; retained section command sources remain independent authorities. */
    getSnapshot: () => snapshot,
    /** Observe until local shell disposal; subscriptions never own a socket or media resource. */
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    /** Open/close/select explicitly, avoiding close-by-toggle races from Escape or obsolete views. */
    execute(command, value) {
      if (disposed) throw new Error("Settings shell disposed");
      refresh();
      if (command === "select") {
        if (!available.includes(value))
          throw new Error("Settings section unavailable");
        selected = value;
      } else {
        if (value !== undefined)
          throw new Error("Unexpected settings shell payload");
        if (command === "open") {
          if (!selected) throw new Error("Settings shell unavailable");
          open = true;
        } else if (command === "close") open = false;
        else throw new Error("Unsupported settings shell command");
      }
      refresh();
    },
    /** Release view observers without affecting any shared meeting engine. */
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  };
}
