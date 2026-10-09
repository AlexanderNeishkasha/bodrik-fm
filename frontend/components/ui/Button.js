"use client";

import styles from "./Button.module.css";

/** Variant classes: ghost (default), accent (primary action) and danger. */
const VARIANTS = Object.freeze({ ghost: "", accent: styles.accent, danger: styles.danger });

/** Player pill button; defaults to a non-submitting action and honors explicit submit/reset. */
export default function Button({ type = "button", variant = "ghost", className = "", children, ...props }) {
  return <button {...props} type={type} className={`${styles.button} ${VARIANTS[variant] ?? ""} ${className}`}>{children}</button>;
}
