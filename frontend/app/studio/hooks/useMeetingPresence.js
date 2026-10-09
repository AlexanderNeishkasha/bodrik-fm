"use client";

import { useEffect, useState } from "react";
import {
  MEETING_FADE_MS,
  MEETING_EXPAND_MS,
} from "../lib/meetingMotion.mjs";

/** Return whether the browser requests motion-free presentation. */
function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Stage meeting control expansion/reveal and reverse fade/collapse. */
export function useMeetingOutputPresence(enabled) {
  const [mounted, setMounted] = useState(enabled);
  const [expanded, setExpanded] = useState(enabled);
  const [visible, setVisible] = useState(enabled);

  useEffect(() => {
    let cancelled = false;
    let frameId = null;
    const timers = [];
    const commit = (callback) => {
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
    };
    if (prefersReducedMotion()) {
      commit(() => {
        setMounted(enabled);
        setExpanded(enabled);
        setVisible(enabled);
      });
    } else if (enabled) {
      commit(() => {
        setMounted(true);
        setVisible(false);
      });
      frameId = requestAnimationFrame(() => {
        if (!cancelled) setExpanded(true);
      });
      timers.push(window.setTimeout(() => {
        if (!cancelled) setVisible(true);
      }, MEETING_EXPAND_MS));
    } else {
      commit(() => setVisible(false));
      timers.push(window.setTimeout(() => {
        if (!cancelled) setExpanded(false);
      }, MEETING_FADE_MS));
      timers.push(window.setTimeout(() => {
        if (!cancelled) setMounted(false);
      }, MEETING_FADE_MS + MEETING_EXPAND_MS));
    }
    return () => {
      cancelled = true;
      if (frameId != null) cancelAnimationFrame(frameId);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [enabled]);

  return { mounted, expanded, visible };
}
