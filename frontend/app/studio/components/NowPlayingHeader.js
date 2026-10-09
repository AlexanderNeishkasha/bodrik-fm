import { ui } from "../../lang/ru";

export default function NowPlayingHeader({
  currentLabel,
  listeners,
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold font-display tracking-[0.08em]">
        {ui.studio.nowPlaying}
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--theme-muted)]">
        <span className="truncate text-[var(--theme-text)]">
          {currentLabel}
        </span>
        <span className="text-xs uppercase tracking-[0.25em] text-[var(--theme-muted)]">
          {ui.studio.listeners} {listeners ?? 0}
        </span>
      </div>
    </div>
  );
}
