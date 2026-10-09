import { useCallback, useState, useSyncExternalStore } from "react";
import { libraryPresenceItems, retainLibraryExits } from "../lib/libraryPresence.mjs";

/** Observe preference changes with one owned listener per library list. */
function subscribeReducedMotion(onChange) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Read the browser's current motion preference. */
function reducedMotionSnapshot() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Keep static markup motion-free before the browser preference is available. */
function serverMotionSnapshot() {
  return true;
}

/** Follow reduced-motion changes without a second synchronized preference state. */
export function useLibraryReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, serverMotionSnapshot);
}

/** Retain only exit snapshots until their keyed animations finish; never delay live filtering. */
export function useLibraryPresence(items) {
  const reducedMotion = useLibraryReducedMotion();
  const [history, setHistory] = useState(() => ({ previous: items, exits: [] }));
  const exits = reducedMotion ? [] : retainLibraryExits(history.exits, history.previous, items);
  // Reconcile render history before commit so departing nodes never unmount/reappear to start a fade.
  if (history.previous !== items || (reducedMotion && history.exits.length > 0)) {
    setHistory({ previous: items, exits });
  }
  const finishExit = useCallback(key => {
    setHistory(current => ({ ...current, exits: current.exits.filter(item => item.key !== key) }));
  }, []);
  return { entries: libraryPresenceItems(items, exits), reducedMotion, finishExit };
}
