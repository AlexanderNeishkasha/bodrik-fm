/** Local per-viewer meeting layout: pinned card, cards hidden from the grid, peer volumes. */
export function createLayout({ storage, slug = "" } = {}) {
  const storageKey = `meeting.volumes.v1:${encodeURIComponent(slug)}`;
  let saved = {};
  try {
    const parsed = JSON.parse(storage?.getItem(storageKey) || "{}");
    saved = Object.fromEntries(Object.entries(parsed || {}).filter(([, value]) => Number.isInteger(value) && value >= 0 && value <= 100));
  } catch { /* Unavailable or malformed storage keeps the default volumes. */ }
  let identities = {};

  /** Use room-scoped display names because session ids change between visits. */
  function identity(id, person) {
    if (id === "bodrik-music") return "bot:music";
    return person?.name && person.name !== id ? `person:${person.name}` : "";
  }
  let snapshot = Object.freeze({ pinned: "", hidden: Object.freeze([]), volumes: Object.freeze({}) });
  const listeners = new Set();

  /** Replace the snapshot and notify. */
  function set(next) {
    snapshot = Object.freeze({ ...snapshot, ...next });
    for (const listener of [...listeners]) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Pin one participant id, or "" to unpin. */
    pin(id) {
      if (typeof id !== "string") throw new Error("Invalid pin");
      if (snapshot.pinned !== id) set({ pinned: id });
    },
    /** Hide or show one participant in this viewer's grid only. */
    setHidden(id, hidden) {
      if (typeof id !== "string" || typeof hidden !== "boolean") throw new Error("Invalid visibility");
      const current = snapshot.hidden.includes(id);
      if (current === hidden) return;
      set({ hidden: Object.freeze(hidden ? [...snapshot.hidden, id] : snapshot.hidden.filter((value) => value !== id)) });
    },
    /** Set one participant's playback volume (0–100). */
    setVolume(id, value) {
      if (typeof id !== "string" || !Number.isInteger(value) || value < 0 || value > 100) throw new Error("Invalid volume");
      if (snapshot.volumes[id] === value) return;
      const key = identities[id];
      if (key) {
        saved = { ...saved, [key]: value };
        try { storage?.setItem(storageKey, JSON.stringify(saved)); }
        catch { /* Playback still works when storage is blocked. */ }
      }
      set({ volumes: Object.freeze({ ...snapshot.volumes, [id]: value }) });
    },
    /** Playback gain (0–1) for one participant. */
    gain: (id) => (snapshot.volumes[id] ?? 100) / 100,
    /** Drop entries for participants that left. */
    retain(ids, participants = {}) {
      const present = new Set(ids);
      const hidden = snapshot.hidden.filter((id) => present.has(id));
      const volumes = Object.fromEntries(Object.entries(snapshot.volumes).filter(([id]) => present.has(id)));
      const nextIdentities = Object.fromEntries(ids.map((id) => [id, identity(id, participants[id])]));
      for (const id of ids) {
        const key = nextIdentities[id];
        if (key && identities[id] !== key && Object.hasOwn(saved, key)) volumes[id] = saved[key];
      }
      identities = nextIdentities;
      // Screen-card pins are keyed "<participantId>:<sourceId>".
      const pinned = present.has(snapshot.pinned.split(":")[0]) ? snapshot.pinned : "";
      if (hidden.length !== snapshot.hidden.length || JSON.stringify(volumes) !== JSON.stringify(snapshot.volumes) || pinned !== snapshot.pinned) {
        set({ hidden: Object.freeze(hidden), volumes: Object.freeze(volumes), pinned });
      }
    },
  };
}
