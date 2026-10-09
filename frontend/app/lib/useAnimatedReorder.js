"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

const DEFAULT_DURATION = 260;
const DEFAULT_EASING = "cubic-bezier(0.2, 0, 0, 1)";

export default function useAnimatedReorder(keys, { duration = DEFAULT_DURATION, easing = DEFAULT_EASING } = {}) {
  const nodesRef = useRef(new Map());
  const rectsRef = useRef(new Map());
  const keysRef = useRef([]);
  const animationsRef = useRef(new Map());

  const registerItem = useCallback((key, node) => {
    if (node) {
      nodesRef.current.set(key, node);
      return;
    }
    nodesRef.current.delete(key);
  }, []);

  useLayoutEffect(() => {
    const nextRects = new Map();
    const nodes = nodesRef.current;

    for (const key of keys) {
      const node = nodes.get(key);
      if (node) {
        nextRects.set(key, node.getBoundingClientRect());
      }
    }

    const previousRects = rectsRef.current;
    const previousKeys = keysRef.current;
    const keysChanged = !areKeysEqual(previousKeys, keys);
    rectsRef.current = nextRects;
    keysRef.current = keys;

    if (previousRects.size === 0 || !keysChanged || prefersReducedMotion()) {
      return;
    }

    for (const key of keys) {
      const node = nodes.get(key);
      const previousRect = previousRects.get(key);
      const nextRect = nextRects.get(key);
      if (!node || !previousRect || !nextRect || !canAnimate(node)) {
        continue;
      }

      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
        continue;
      }

      animationsRef.current.get(key)?.cancel();
      node.style.willChange = "transform";
      const animation = node.animate([{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: "translate(0, 0)" }], {
        duration,
        easing,
      });

      animationsRef.current.set(key, animation);
      animation.finished
        .catch(() => {})
        .finally(() => {
          if (animationsRef.current.get(key) === animation) {
            animationsRef.current.delete(key);
            node.style.willChange = "";
          }
        });
    }
  }, [duration, easing, keys]);

  return registerItem;
}

function areKeysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((key, index) => Object.is(key, right[index]));
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function canAnimate(node) {
  return typeof node.animate === "function";
}
