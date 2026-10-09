import { ui } from "../../lang/ru";
import Icon from "../../components/Icon";

export default function NowPlayingControls({
  isPlaying,
  onPause,
  onResume,
  onSkip,
  positionLabel,
  isRepeatOn,
  onToggleRepeat,
}) {
  const repeatLabel = isRepeatOn
    ? ui.studio.repeatDisable
    : ui.studio.repeatEnable;
  const repeatClassName = isRepeatOn
    ? "btn-accent bg-[var(--theme-accent)] text-[var(--theme-text-dark)] hover:bg-[var(--theme-accent-bright)]"
    : "btn-ghost";

  return (
    <div className="flex flex-nowrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {isPlaying ? (
          <button
            onClick={onPause}
            aria-label={ui.studio.pause}
            title={ui.studio.pause}
            data-hotkey-press="playback"
            className="btn-accent inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60"
          >
            <Icon name="pause" className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={onResume}
            aria-label={ui.studio.resume}
            title={ui.studio.resume}
            data-hotkey-press="playback"
            className="btn-accent inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60"
          >
            <Icon name="play" className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={onToggleRepeat}
          aria-label={repeatLabel}
          title={repeatLabel}
          aria-pressed={isRepeatOn}
          className={`inline-flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-60 ${repeatClassName}`}
        >
          <Icon name="repeat" className="h-4 w-4" />
        </button>
        <button
          onClick={onSkip}
          aria-label={ui.studio.nextTrack}
          title={ui.studio.nextTrack}
          className="btn-accent inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)] disabled:opacity-60"
        >
          <Icon name="next" className="h-4 w-4" />
        </button>
      </div>
      <div className="w-24 shrink-0 text-right text-xl font-semibold text-[var(--theme-text)] tabular-nums">
        {positionLabel}
      </div>
    </div>
  );
}
