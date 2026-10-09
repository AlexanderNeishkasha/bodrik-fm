"use client";

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import styles from "./MeetingGrid.module.css";

/** Float a card menu in the room layer, below panels, and keep it inside the viewport. */
export default function CardMenu({ anchor, text, children, menuRef }) {
  const localRef = useRef(null);
  const host = document.fullscreenElement || anchor.current?.closest("main[data-meeting-status]");
  useLayoutEffect(() => {
    const node = localRef.current;
    if (!node) return undefined;
    /** Reposition after the anchor or viewport moves, flipping above when needed. */
    const place = () => {
      const trigger = anchor.current?.getBoundingClientRect();
      if (!trigger) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      node.style.maxHeight = `${height - 16}px`;
      node.style.maxWidth = `${width - 16}px`;
      const menu = node.getBoundingClientRect();
      const below = trigger.bottom + 6;
      const above = trigger.top - menu.height - 6;
      node.style.left = `${Math.max(left + 8, Math.min(trigger.right - menu.width, left + width - menu.width - 8))}px`;
      node.style.top = `${Math.max(top + 8, Math.min(below + menu.height <= top + height - 8 ? below : above, top + height - menu.height - 8))}px`;
      node.style.visibility = "visible";
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(node);
    if (anchor.current) resize.observe(anchor.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      menuRef.current = null;
    };
  }, [anchor, menuRef, host]);
  if (!host) return null;
  return createPortal(<div ref={(node) => { localRef.current = node; menuRef.current = node; }} className={styles.cardMenu}
    role="menu" aria-label={text} style={{ visibility: "hidden" }}>{children}</div>, host);
}
