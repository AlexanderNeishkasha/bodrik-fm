"use client";

import { useId } from "react";
import RangeControl from "../../../components/ui/RangeControl";
import SwitchControl from "../../../components/ui/SwitchControl";
import HelpTooltip from "../../../components/ui/HelpTooltip";
import styles from "./SettingControls.module.css";

/** Share label, description and control layout without owning preference state. */
export function SettingRow({ label, description, icon, helpLabel = "Help", children, className = "" }) {
  const title = <span className={styles.label}>{icon}{label}</span>;
  return <div className={`${styles.row} ${className}`}><div className={styles.copy}>{description ? <HelpTooltip label={`${helpLabel}: ${label}`} content={description}>{title}</HelpTooltip> : title}</div>{children}</div>;
}

/** Share a controlled native slider: input previews continuously, pointer/keyboard/blur boundaries commit. */
export function SettingSlider({ label, value, min = 0, max = 100, step = 1, suffix = "", disabled, onPreview, onCommit }) {
  const id = useId();
  /** Commit the DOM's current value, including keyboard edits before React finishes a render. */
  function commit(event) { onCommit(Number(event.currentTarget.value)); }
  return <div className={styles.sliderControl}>
    <RangeControl id={id} label={label} min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onPreview(Number(event.target.value))} onPointerUp={commit} onPointerCancel={commit} onBlur={commit} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commit(event); }} />
    <output className={styles.sliderValue} htmlFor={id}>{value}{suffix}</output>
  </div>;
}

/** Render an accessible controlled switch; commands and persistence belong to the caller. */
export function SettingSwitch({ label, checked, disabled, onChange }) {
  return <SwitchControl label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
}
