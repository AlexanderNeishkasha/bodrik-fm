"use client";

import { useId } from "react";
import styles from "./SwitchControl.module.css";

/** Render a controlled native switch; the caller owns validation, commands and persistence. */
export default function SwitchControl({ label, id, className = "", ...props }) {
  const generatedId = useId();
  return <input {...props} id={id || generatedId} className={`${styles.switch} ${className}`} type="checkbox" role="switch" aria-label={label} />;
}
