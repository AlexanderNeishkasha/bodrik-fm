import { useDroppable } from "@dnd-kit/core";
import AudioGlow from "../../components/AudioGlow";
import { ui } from "../../lang/ru";
import NowPlayingControls from "./NowPlayingControls";
import NowPlayingHeader from "./NowPlayingHeader";
import NowPlayingSeek from "./NowPlayingSeek";
import NowPlayingVolume from "./NowPlayingVolume";

/** Render playback controls with local Studio or meeting-wide output gain. */
export default function NowPlayingPanel({
  audioRef,
  currentLabel,
  listeners,
  isPlaying,
  positionLabel,
  seekValue,
  seekMax,
  onSeekChange,
  onSeekCommit,
  onPause,
  onResume,
  onSkip,
  isRepeatOn,
  onToggleRepeat,
  localVolume,
  localMuted,
  onToggleMute,
  onVolumeChange,
  outputForcedMuted,
  musicOutput,
  dropId,
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  return (
    <section
      className={`panel-shadow-card audio-glow-card relative z-20 min-w-0 rounded-[24px] border border-[var(--theme-border)] bg-[var(--theme-card)] p-6 ${
        isOver ? "ring-2 ring-[var(--theme-accent-60)]" : ""
      }`}
      ref={setNodeRef}
    >
      <AudioGlow />
      <div className="relative z-10 space-y-4">
        <audio
          ref={audioRef}
          muted={localMuted || outputForcedMuted}
          playsInline
          preload="metadata"
          crossOrigin="anonymous"
        />
        <NowPlayingHeader currentLabel={currentLabel} listeners={listeners} />
        <NowPlayingControls
          isPlaying={isPlaying}
          onPause={onPause}
          onResume={onResume}
          onSkip={onSkip}
          isRepeatOn={isRepeatOn}
          onToggleRepeat={onToggleRepeat}
          positionLabel={positionLabel}
        />
        <NowPlayingSeek
          seekValue={seekValue}
          seekMax={seekMax}
          onSeekChange={onSeekChange}
          onSeekCommit={onSeekCommit}
        />
        <NowPlayingVolume
          label={musicOutput === "conference" ? ui.studio.meetingVolume : undefined}
          localVolume={localVolume}
          localMuted={localMuted}
          onToggleMute={onToggleMute}
          onVolumeChange={onVolumeChange}
        />
      </div>
    </section>
  );
}
