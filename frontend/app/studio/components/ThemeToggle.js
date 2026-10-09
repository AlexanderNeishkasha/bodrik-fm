"use client";

import { useEffect, useState } from "react";
import { deferEffect } from "../../lib/deferEffect";

export default function ThemeToggle({ currentTheme, onThemeChange, isBusy }) {
  const [pendingTheme, setPendingTheme] = useState(null);
  const activeTheme = pendingTheme ?? currentTheme ?? "crimson";

  useEffect(() => deferEffect(() => setPendingTheme(null)), [currentTheme]);

  const handleChange = async (value) => {
    if (value === currentTheme || isBusy) {
      return;
    }
    setPendingTheme(value);
    const ok = (await onThemeChange?.(value)) !== false;
    if (!ok) {
      setPendingTheme(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-[var(--theme-border)] bg-[var(--theme-card)] px-6 py-4">
      <div className="text-xs uppercase tracking-[0.35em] text-[var(--theme-muted)]">
        Тема
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => handleChange("mono")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "mono"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Pirate
        </button>
        <button
          type="button"
          onClick={() => handleChange("crimson")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "crimson"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Crimson
        </button>
        <button
          type="button"
          onClick={() => handleChange("midnight")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "midnight"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Midnight
        </button>
        <button
          type="button"
          onClick={() => handleChange("ivory")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "ivory"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Ivory
        </button>
        <button
          type="button"
          onClick={() => handleChange("lucifer")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "lucifer"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Lucifer
        </button>
        <button
          type="button"
          onClick={() => handleChange("aurora")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "aurora"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Aurora
        </button>
        <button
          type="button"
          onClick={() => handleChange("saffron")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "saffron"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Saffron
        </button>
        <button
          type="button"
          onClick={() => handleChange("prism")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "prism"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Prism
        </button>
        <button
          type="button"
          onClick={() => handleChange("mythic")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "mythic"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Mythic
        </button>
        <button
          type="button"
          onClick={() => handleChange("grove")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "grove"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Grove
        </button>
        <button
          type="button"
          onClick={() => handleChange("spectrum")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "spectrum"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Spectrum
        </button>
        <button
          type="button"
          onClick={() => handleChange("pirate")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "pirate"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Noir
        </button>
        <button
          type="button"
          onClick={() => handleChange("emberveil")}
          disabled={isBusy}
          className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] transition disabled:opacity-60 ${
            activeTheme === "emberveil"
              ? "bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
              : "btn-ghost"
          }`}
        >
          Emberveil
        </button>
      </div>
    </div>
  );
}
