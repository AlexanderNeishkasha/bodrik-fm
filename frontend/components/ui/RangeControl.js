"use client";

import { rangeProgress } from "./rangeModel.mjs";
import styles from "./RangeControl.module.css";

/** Share native range rendering/styles; callers retain event handlers, value units and commit semantics. */
export default function RangeControl({ label, value, min = 0, max = 100, step = 1, className = "", style, ...props }) {
  return <input {...props} type="range" aria-label={label} value={value} min={min} max={max} step={step} className={`${styles.range} ${className}`} style={{ ...style, "--range-progress": `${rangeProgress(value, min, max)}%` }} />;
}
