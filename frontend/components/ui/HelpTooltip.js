"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createTooltipLayer } from "./tooltipLayer";
import { tooltipPosition } from "./tooltipPosition.mjs";
import styles from "./HelpTooltip.module.css";

/** Show isolated, viewport-bound help outside clipped panels; focus/tap and Escape also work without hover. */
export default function HelpTooltip({ label, content, children }) {
  const id = useId();
  const anchorRef = useRef(null);
  const tipRef = useRef(null);
  const closeTimer = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [layer, setLayer] = useState(null);
  const visible = (hovered || focused) && !dismissed;

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    if (!visible) return;
    const current = createTooltipLayer(anchorRef.current, styles.tooltip);
    current.syncAppearance();
    setLayer(current);
    return () => { current.dispose(); setLayer(null); };
  }, [visible]);

  useLayoutEffect(() => {
    if (!layer || !tipRef.current) return;
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    const window = anchor.ownerDocument.defaultView;
    /** Recompute geometry and inherited appearance without a second theme/preference state source. */
    function update() {
      if (!anchor.isConnected) return;
      layer.syncAppearance();
      const visual = window.visualViewport;
      const viewport = { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0, width: visual?.width || window.innerWidth, height: visual?.height || window.innerHeight };
      tip.style.width = `${Math.min(280, Math.max(1, viewport.width - 16))}px`;
      tip.style.maxHeight = `${Math.max(1, viewport.height - 16)}px`;
      const position = tooltipPosition(anchor.getBoundingClientRect(), tip.getBoundingClientRect(), viewport);
      tip.style.left = `${position.x}px`;
      tip.style.top = `${position.y}px`;
      tip.style.visibility = "visible";
    }
    update();
    const resize = new window.ResizeObserver(update);
    resize.observe(anchor);
    resize.observe(tip);
    const theme = new window.MutationObserver(update);
    theme.observe(anchor.ownerDocument.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    theme.observe(anchor.ownerDocument.body, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      resize.disconnect(); theme.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [layer, content]);

  /** Keep help open across the small pointer gap between the anchor and detached visual layer. */
  function enter() { clearTimeout(closeTimer.current); setHovered(true); setDismissed(false); }
  /** Delay hover release; focused help stays visible until blur or explicit dismissal. */
  function leave() { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setHovered(false), 120); }

  return <span className={styles.help}>
    {children}
    <button ref={anchorRef} className={styles.button} type="button" aria-label={label} aria-describedby={id}
      onMouseEnter={enter} onMouseLeave={leave}
      onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)}
      onKeyDown={(event) => { if (event.key === "Escape" && visible) { setDismissed(true); event.preventDefault(); event.stopPropagation(); } }}
    >?</button>
    <span id={id} hidden>{content}</span>
    {visible && layer && createPortal(<span ref={tipRef} className={styles.tooltip} role="tooltip" onMouseEnter={enter} onMouseLeave={leave} onClick={(event) => event.stopPropagation()} style={{ visibility: "hidden" }}>{content}</span>, layer.container)}
  </span>;
}
