import { useLayoutEffect, useRef } from "react";

/** Fade only on entry/exit; retained keys keep their DOM node and do not replay on query edits. */
export default function LibraryFadeItem({ entryKey, isExiting, reducedMotion, onExited, children }) {
  const nodeRef = useRef(null);
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    const node = nodeRef.current;
    const from = mountedRef.current || isExiting ? getComputedStyle(node).opacity : "0";
    const target = isExiting ? "0" : "1";
    mountedRef.current = true;
    node.style.opacity = target;
    if (reducedMotion) {
      if (isExiting) onExited(entryKey);
      return undefined;
    }
    const animation = node.animate([{ opacity: from }, { opacity: target }], {
      duration: 150, easing: "ease-out", fill: "both",
    });
    animation.onfinish = () => {
      node.style.opacity = target;
      animation.cancel();
      if (isExiting) onExited(entryKey);
    };
    return () => {
      node.style.opacity = getComputedStyle(node).opacity;
      animation.onfinish = null;
      animation.cancel();
    };
  }, [entryKey, isExiting, reducedMotion, onExited]);
  return (
    <div
      ref={nodeRef}
      data-library-presence={entryKey}
      data-exiting={isExiting ? "true" : undefined}
      aria-hidden={isExiting || undefined}
      inert={isExiting}
    >
      {children}
    </div>
  );
}
