/** Own debounced receiver visibility; camera pauses never affect participant audio. */
export function createVideoVisibility({ apply, schedule = setTimeout, cancel = clearTimeout }) {
  const states = new Map();
  const timers = new Map();
  let closed = false;
  return {
    /** Unknown sources are visible until their first DOM visibility observation. */
    visible: (id) => states.get(id) !== false,
    /** Delay hiding during layout/focus animation, but restore visible video immediately. */
    set(id, visible) {
      if (closed) return;
      cancel(timers.get(id));
      timers.delete(id);
      const commit = () => {
        timers.delete(id);
        if (closed || states.get(id) === visible) return;
        states.set(id, visible);
        apply(id, visible);
      };
      if (visible) commit();
      else timers.set(id, schedule(commit, 350));
    },
    /** Release removed sources so repeated joins never retain old visibility entries. */
    retain(ids) {
      const present = new Set(ids);
      for (const id of new Set([...states.keys(), ...timers.keys()])) if (!present.has(id)) {
        cancel(timers.get(id));
        timers.delete(id);
        states.delete(id);
      }
    },
    /** Cancel every pending visibility change before media disposal. */
    close() {
      closed = true;
      for (const timer of timers.values()) cancel(timer);
      timers.clear();
      states.clear();
    },
  };
}
