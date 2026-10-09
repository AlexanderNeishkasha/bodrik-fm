/**
 * Apply a change synchronously (React's flushSync) and settle after two animation
 * frames, so layout that is re-measured afterwards (the grid's ResizeObserver) is in
 * the transition's "after" snapshot too.
 */
export function flushAndSettle(flushSync, scope = globalThis) {
  return (change) => {
    flushSync(change);
    // Containers that only changed size (no re-render) re-fit synchronously, so the
    // transition's "after" snapshot already has the final layout.
    scope.dispatchEvent?.(new Event(RELAYOUT_EVENT));
    return new Promise((resolve) => {
      scope.requestAnimationFrame(() => scope.requestAnimationFrame(resolve));
      // Animation frames pause in background tabs; never hold the transition for long.
      (scope.setTimeout ?? setTimeout)(resolve, SETTLE_DEADLINE_MS);
    });
  };
}

/** A valid, unique `view-transition-name` for one card key. */
export function transitionName(key) {
  return `meeting-card-${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** Event asking layout owners (the card grid) to re-measure right now. */
export const RELAYOUT_EVENT = "meeting-relayout";

/** Apply a pending change directly if the transition has not run it by then. */
const TRANSITION_DEADLINE_MS = 300;

/** Upper bound for waiting on re-measured layout inside a transition. */
const SETTLE_DEADLINE_MS = 120;

/**
 * Run a layout change inside a View Transition when the browser supports it and the
 * user has not asked for reduced motion; otherwise apply it directly. `flush(change)`
 * applies the change and may return a promise that settles once it is on screen
 * (React's flushSync, or a commit promise for changes made from effects).
 */
export function withViewTransition(change, flush, scope = globalThis) {
  const reduce = scope.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const hidden = scope.document?.visibilityState === "hidden";
  // A transition draws its snapshots above everything, modal dialogs included, so
  // while settings/share/about are open the change is applied without animation.
  const modal = Boolean(scope.document?.querySelector?.("dialog:modal"));
  if (reduce || hidden || modal || typeof scope.document?.startViewTransition !== "function") {
    change();
    return;
  }
  // The browser runs the update only at its next rendering opportunity; if that does
  // not come soon (background tab), apply the change anyway so state never stalls.
  let applied = false;
  const apply = () => {
    if (applied) return undefined;
    applied = true;
    return flush(change);
  };
  (scope.setTimeout ?? setTimeout)(() => {
    if (!applied) {
      applied = true;
      change();
    }
  }, TRANSITION_DEADLINE_MS);
  const transition = scope.document.startViewTransition(apply);
  // A newer transition skips this one (e.g. two quick joins); that is expected, not an error.
  for (const promise of [transition?.ready, transition?.finished, transition?.updateCallbackDone]) promise?.catch(() => {});
}
