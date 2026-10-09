"use client";

import { useEffect, useRef } from "react";

/** Phones and tablets, where meeting overlays are fullscreen; must match the panels' CSS. */
export const FULLSCREEN_OVERLAY_QUERY = "(max-width: 1024px)";

/** History state key holding how many meeting overlays are stacked on this entry. */
const DEPTH_KEY = "meetingOverlayDepth";

/** Overlay depth recorded in a history state, or 0. */
function depthOf(state) {
  return Number(state?.[DEPTH_KEY]) || 0;
}

/**
 * On phones and tablets, an open overlay owns one history entry, so the system back
 * gesture/button closes it instead of leaving the meeting. Closing it from the UI
 * removes that entry again. Stacked overlays close one per back step, top first.
 */
export function useBackClose(open, close) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    if (!open || !window.matchMedia?.(FULLSCREEN_OVERLAY_QUERY).matches) return undefined;
    const depth = depthOf(history.state) + 1;
    // Keep the router's own state fields; only the overlay depth is added.
    history.pushState({ ...history.state, [DEPTH_KEY]: depth }, "");
    let popped = false;
    /** Close when back leaves this overlay's entry (the new entry is shallower). */
    const onPop = (event) => {
      if (depthOf(event.state) >= depth) return;
      popped = true;
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!popped && depthOf(history.state) === depth) history.back();
    };
  }, [open]);
}
