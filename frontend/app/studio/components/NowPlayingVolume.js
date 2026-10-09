import { ui } from "../../lang/ru";
import Icon from "../../components/Icon";
import RangeControl from "../../../components/ui/RangeControl";

/** Reuse one slider/mute pair for local listening or the room's meeting output. */
export default function NowPlayingVolume({
  label = ui.studio.volume,
  disabled = false,
  localVolume,
  localMuted,
  onToggleMute,
  onVolumeChange,
}) {
  const muteLabel = localMuted ? ui.main.unmute : ui.main.mute;

  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-[0.25em] text-[var(--theme-muted)]">
        {label}
      </div>
      <div className="flex items-center gap-4">
        <button
          onClick={onToggleMute}
          disabled={disabled}
          aria-label={muteLabel}
          title={muteLabel}
          data-hotkey-press="mute"
          className={`inline-flex h-9 w-9 aspect-square items-center justify-center rounded-full p-0 transition disabled:opacity-50 disabled:cursor-not-allowed ${
            localMuted || localVolume === 0
              ? "btn-ghost"
              : "btn-accent bg-[var(--theme-accent)] text-[var(--theme-text-dark)] hover:bg-[var(--theme-accent-bright)]"
          }`}
        >
          {localMuted || localVolume === 0 ? (
            <Icon name="volume-mute" className="h-4 w-4" />
          ) : (
            <Icon name="volume" className="h-4 w-4" />
          )}
        </button>
        <RangeControl
          label={label}
          disabled={disabled}
          min="0"
          max="1"
          step="0.01"
          value={localVolume}
          onChange={onVolumeChange}
        />
      </div>
    </div>
  );
}
