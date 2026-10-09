import { useEffect, useRef, useState } from "react";
import { ui } from "../lang/ru";
import { pickNextBodrickPhrase } from "../lib/bodrickHatPhrases";
import bodrickHat from "../assets/bodrick_hat.png";
import angryBodrick from "../assets/bodrik_angry.png";
import joyBodrick from "../assets/bodrik_joy.png";
import treacherousBodrick from "../assets/bodrik_treacherous.png";
import { ArrowLeft } from "lucide-react";
import AudioGlow from "./AudioGlow";
import AssetImage from "./AssetImage";
import Icon from "./Icon";
import RangeControl from "../../components/ui/RangeControl";
import styles from "./MainPlayerPanel.module.css";

const BODRICK_VARIANTS = {
  angry: angryBodrick,
  joy: joyBodrick,
  treacherous: treacherousBodrick,
};
const CLICKS_TO_BODRICK = 5;
const BODRICK_VISIBLE_MS = 3000;

/** Render public playback controls; local volume/mute remain owned by the player hooks. */
export default function MainPlayerPanel({
  audioRef,
  playButtonRef,
  roomSlug,
  onBack,
  status,
  isFlybyActive,
  onBodrickActiveChange,
  isPlaying,
  isLocalPaused,
  onTogglePause,
  isMuted,
  volume,
  isSliderReady,
  onToggleMute,
  onVolumeChange,
}) {
  const hatClickCountRef = useRef(0);
  const hideBodrickTimerRef = useRef(null);
  const [bodrick, setBodrick] = useState(null);
  const [bodrickPhase, setBodrickPhase] = useState("idle");
  const isBodrickActive = bodrickPhase !== "idle";
  const isHatDisabled = isBodrickActive || isFlybyActive;

  useEffect(() => {
    return () => {
      clearTimeout(hideBodrickTimerRef.current);
      onBodrickActiveChange(false);
    };
  }, [onBodrickActiveChange]);

  const handleHatClick = (event) => {
    event.stopPropagation();
    if (isHatDisabled) {
      return;
    }

    hatClickCountRef.current += 1;
    if (hatClickCountRef.current < CLICKS_TO_BODRICK) {
      return;
    }

    hatClickCountRef.current = 0;
    const phrase = pickNextBodrickPhrase({
      isPlaying,
      isLocalPaused,
      isMuted,
      volume,
    });
    setBodrick({ image: BODRICK_VARIANTS[phrase.variant], phrase: phrase.text });
    setBodrickPhase("entering");
    onBodrickActiveChange(true);
  };

  const handleBodrickAnimationEnd = () => {
    if (bodrickPhase === "entering") {
      setBodrickPhase("shown");
      hideBodrickTimerRef.current = setTimeout(() => {
        setBodrickPhase("exiting");
      }, BODRICK_VISIBLE_MS);
      return;
    }

    if (bodrickPhase === "exiting") {
      setBodrickPhase("idle");
      setBodrick(null);
      onBodrickActiveChange(false);
    }
  };

  return (
    <main
      className={`${styles.panel} select-none panel-shadow-hero audio-glow-hero relative rounded-[32px] border border-[var(--theme-border)] bg-[var(--theme-card)] p-10`}
    >
      <AudioGlow />
      <button
        type="button"
        aria-label={ui.main.touchHat}
        className={`${styles.hat} ${isHatDisabled ? styles.hatBusy : ""}`}
        style={{ "--hat-image": `url("${bodrickHat.src}")` }}
        onClick={handleHatClick}
        disabled={isHatDisabled}
      >
        {bodrick ? (
          <span
            aria-hidden="true"
            className={`${styles.bodrick} ${styles[`bodrick${bodrickPhase}`]}`}
            onAnimationEnd={handleBodrickAnimationEnd}
          >
            <AssetImage
              src={bodrick.image}
              alt=""
              className={styles.bodrickImage}
            />
            {bodrickPhase === "shown" ? (
              <span className={styles.bodrickSpeech}>{bodrick.phrase}</span>
            ) : null}
          </span>
        ) : null}
        <AssetImage
          src={bodrickHat}
          alt=""
          className={styles.hatImage}
          priority
        />
      </button>
      <div className={`${styles.content} space-y-5`}>
        <header className={`${styles.header} flex min-h-8 items-center gap-4 pl-12`}>
          <div className={`${styles.statusLabel} min-w-0 flex-1 text-xs uppercase tracking-[0.45em] text-[var(--theme-muted)]`}>
            <span className="select-text">{ui.main.statusLabel}:</span>{" "}
            <span className="select-text font-semibold text-[var(--theme-text)]">
              {status === "connected"
                ? ui.main.status.connected
                : status === "connecting"
                  ? ui.main.status.connecting
                  : ui.main.status.error}
            </span>
          </div>
          {roomSlug ? <div className="max-w-40 select-text truncate text-right text-sm text-[var(--theme-muted)]">{roomSlug}</div> : null}
        </header>

        <section
          className={`${styles.controls} panel-shadow-panel space-y-6 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] p-6`}
        >
          <audio ref={audioRef} playsInline preload="metadata" crossOrigin="anonymous" />
          <div className="flex items-center justify-center">
            <button
              ref={playButtonRef}
              onClick={onTogglePause}
              aria-label={isLocalPaused ? ui.main.play : ui.main.pause}
              data-hotkey-press="playback"
              className="btn-accent inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:-translate-y-[1px] hover:bg-[var(--theme-accent-bright)]"
            >
              {isLocalPaused ? <Icon name="play" className="h-8 w-8" /> : <Icon name="pause" className="h-8 w-8" />}
            </button>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <button
                onClick={onToggleMute}
                aria-label={isMuted ? ui.main.unmute : ui.main.mute}
                data-hotkey-press="mute"
                className={`inline-flex h-11 w-11 aspect-square items-center justify-center rounded-full p-0 transition ${
                  isMuted || volume === 0
                    ? "btn-ghost"
                    : "btn-accent bg-[var(--theme-accent)] text-[var(--theme-text-dark)] hover:bg-[var(--theme-accent-bright)]"
                }`}
              >
                {isMuted || volume === 0 ? <Icon name="volume-mute" className="h-5 w-5" /> : <Icon name="volume" className="h-5 w-5" />}
              </button>
              {isSliderReady ? (
                <RangeControl
                  label={ui.main.hotkeys.volume}
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={onVolumeChange}
                />
              ) : (
                <div className="h-2 w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-ghost)]" />
              )}
            </div>
          </div>
        </section>
      </div>
      <button
        type="button"
        onClick={onBack}
        aria-label={ui.main.backToRooms}
        title={ui.main.backToRooms}
        className={`${styles.backButton} absolute left-10 top-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--theme-accent)] transition hover:-translate-y-[1px] hover:text-[var(--theme-accent-bright)] active:scale-95`}
      >
        <ArrowLeft aria-hidden="true" className="h-6 w-6" strokeWidth={2.4} />
      </button>
    </main>
  );
}
