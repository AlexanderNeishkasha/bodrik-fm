"use client";

import { useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import Link from "next/link";
import BodrickFlyby from "./BodrickFlyby";
import { statusPageHref } from "../lib/statusNavigation.mjs";

/** Shared themed destination for site errors and meeting outcomes. */
export default function BrandedStatusPage({ eyebrow, title, description, actions = [], children, language = "ru" }) {
  const reducedMotion = useSyncExternalStore(subscribeMotion, motionSnapshot, () => true);
  const firstAction = useRef(null);
  const [interactionToken, bumpInteraction] = useReducer(value => value + 1, 0);
  useEffect(() => { firstAction.current?.focus(); }, [title]);
  return <div className="mobile-surface-screen hero-bg min-h-screen text-[var(--theme-text)]" lang={language} onClick={bumpInteraction}>
    <BodrickFlyby interactionToken={interactionToken} storageKey="bodrick_misses" disabled={reducedMotion} />
    <div className="mobile-surface-shell mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <main className="mobile-surface-panel mobile-surface-center panel-shadow-hero space-y-6 rounded-[32px] border border-[var(--theme-border)] bg-[var(--theme-card)] p-10">
        {eyebrow && <div className="text-xs uppercase tracking-[0.45em] text-[var(--theme-muted)]">{eyebrow}</div>}
        <h1 className="text-3xl font-semibold font-display tracking-[0.08em]">{title}</h1>
        {description && <p role="status" className="text-sm text-[var(--theme-muted)]">{description}</p>}
        {children}
        <div className="flex flex-wrap gap-3">
          {actions.map((action, index) => {
            const className = `inline-flex items-center justify-center rounded-full border px-6 py-2 text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-wait ${index === 0 ? "border-[var(--theme-accent)] bg-[var(--theme-accent)] text-[var(--theme-text-dark)] hover:bg-[var(--theme-accent-bright)]" : "border-[var(--theme-border)] text-[var(--theme-text)] hover:bg-[var(--theme-panel-hover)]"}`;
            return action.href ? <Link key={action.label} ref={index === 0 ? firstAction : undefined} href={statusPageHref(action.href)} className={className}>{action.label}</Link>
              : <button key={action.label} ref={index === 0 ? firstAction : undefined} type="button" className={className} disabled={action.disabled} onClick={action.onClick}>{action.label}</button>;
          })}
        </div>
      </main>
    </div>
  </div>;
}

/** Observe the system motion preference for the decorative flyby. */
function subscribeMotion(listener) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** Read the browser preference without storing a second copy. */
function motionSnapshot() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
