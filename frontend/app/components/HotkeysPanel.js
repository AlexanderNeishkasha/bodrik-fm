export default function HotkeysPanel({
  title,
  hideLabel,
  onHide,
  entries,
  className,
  suppressHydrationWarning,
}) {
  return (
    <div className="hotkeys-shell pointer-events-none fixed bottom-5 right-6 hidden md:block">
      <div
        className={`hotkeys-panel panel-shadow-panel pointer-events-auto space-y-2 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] px-4 py-3 text-[11px] uppercase tracking-[0.2em] text-[var(--theme-muted)] ${className}`}
      >
        <div className="flex items-center justify-between gap-4 text-[10px] tracking-[0.35em] text-[var(--theme-muted)]">
          <span>{title}</span>
          <button
            type="button"
            onClick={onHide}
            data-hotkey-press="hotkeys"
            className="btn-ghost flex h-6 w-6 items-center justify-center rounded-full text-[var(--theme-accent)]"
            aria-label={hideLabel}
            suppressHydrationWarning={suppressHydrationWarning}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-3 w-3"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12" />
              <path d="M18 6l-12 12" />
            </svg>
          </button>
        </div>
        {entries.map((entry) => (
          <div
            key={`${entry.key}-${entry.label}`}
            className={`flex items-center justify-between gap-8 ${
              entry.isHint
                ? "text-[10px] tracking-[0.35em] text-[var(--theme-muted)]"
                : ""
            }`}
          >
            <span className="text-[var(--theme-text)]">{entry.key}</span>
            <span>{entry.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
