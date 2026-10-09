"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import styles from "./SelectControl.module.css";

/** Controlled, themed combobox; consumers retain ownership of options and commands. */
export default function SelectControl({ label, options, placeholder = "—", className = "", value, disabled, onChange, ...props }) {
  const id = useId();
  const trigger = useRef(null);
  const popup = useRef(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.findIndex((option) => String(option.value) === String(value));
  const available = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  if (disabled && open) setOpen(false);

  /** Open on the selected enabled option, or the first available choice. */
  function expand() {
    setActive(available.includes(selected) ? selected : available[0] ?? 0);
    setOpen(true);
  }

  /** Commit an enabled option using the existing value-change consumer contract. */
  function choose(index) {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    trigger.current?.focus();
    onChange?.({ target: { value: String(option.value) }, currentTarget: { value: String(option.value) } });
  }

  /** Keep focus on the combobox while navigating its list, including typeahead. */
  function keyDown(event) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) expand();
      const start = open ? active : selected;
      const position = available.indexOf(start);
      if (event.key === "Home") setActive(available[0] ?? 0);
      else if (event.key === "End") setActive(available.at(-1) ?? 0);
      else setActive(available[(position + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length] ?? 0);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(active);
      else expand();
    } else if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    } else if (event.key === "Tab") setOpen(false);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      search.current = { text: (now - search.current.time < 700 ? search.current.text : "") + event.key.toLocaleLowerCase(), time: now };
      const match = available.find((index) => String(options[index].label).toLocaleLowerCase().startsWith(search.current.text));
      if (!open) expand();
      if (match !== undefined) setActive(match);
    }
  }

  // A top-layer popover preserves inherited theme styles and escapes scrolling panels.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current;
    const list = popup.current;
    const document = anchor.ownerDocument;
    const window = document.defaultView;
    list.showPopover?.();
    /** Fit the list to the visible viewport, flipping above when there is more room. */
    function position() {
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const below = top + height - rect.bottom - 14;
      const above = rect.top - top - 14;
      const upwards = below < Math.min(list.scrollHeight, 240) && above > below;
      const room = Math.max(40, upwards ? above : below);
      list.style.width = `${Math.min(rect.width, width - 16)}px`;
      list.style.maxHeight = `${Math.min(320, room)}px`;
      list.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - list.offsetWidth - 8))}px`;
      const y = upwards ? rect.top - list.offsetHeight - 6 : rect.bottom + 6;
      list.style.top = `${Math.max(top + 8, Math.min(y, top + height - list.offsetHeight - 8))}px`;
    }
    /** Dismiss without stealing focus from the clicked control. */
    function outside(event) {
      if (!anchor.contains(event.target) && !list.contains(event.target)) setOpen(false);
    }
    /** Close only this list on Escape, before a surrounding settings modal reacts. */
    function escape(event) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); anchor.focus(); }
    }
    position();
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      if (list.hidePopover && list.matches(":popover-open")) list.hidePopover();
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) popup.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  return <>
    <button {...props} ref={trigger} type="button" role="combobox" aria-label={label} aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined}
      disabled={disabled} className={`${styles.select} ${className}`} onKeyDown={keyDown} onClick={() => open ? setOpen(false) : expand()}>
      <span className={styles.value}>{options[selected]?.label || placeholder}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && <div ref={popup} id={id} role="listbox" aria-label={label} popover="manual" className={styles.popup}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" data-index={index}
        aria-selected={index === selected} aria-disabled={!!option.disabled} data-active={index === active}
        className={styles.option} onPointerMove={() => !option.disabled && setActive(index)}
        onPointerDown={(event) => { if (event.pointerType === "mouse") event.preventDefault(); }} onClick={() => choose(index)}>
        <span>{option.label}</span><span className={styles.check}>{index === selected && <Check size={16} aria-hidden="true" />}</span>
      </div>)}
      {!options.length && <div className={styles.option} role="option" aria-selected="false" aria-disabled="true">{placeholder}</div>}
    </div>}
  </>;
}
