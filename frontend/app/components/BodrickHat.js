"use client";

import { useEffect, useRef, useState } from "react";
import { t } from "../lang/index.js";
import { pickNextBodrickPhrase } from "../lib/bodrickHatPhrases";
import bodrickHat from "../assets/bodrick_hat.svg";
import angryBodrick from "../assets/bodrik_angry.svg";
import joyBodrick from "../assets/bodrik_joy.svg";
import treacherousBodrick from "../assets/bodrik_treacherous.svg";
import AssetImage from "./AssetImage";
import styles from "./BodrickHat.module.css";

const BODRICK_VARIANTS = {
  angry: angryBodrick,
  joy: joyBodrick,
  treacherous: treacherousBodrick,
};
const CLICKS_TO_BODRICK = 5;
const BODRICK_VISIBLE_MS = 3000;

/** Render the shared hat and its click-triggered Bodrick appearance. */
export default function BodrickHat({
  isFlybyActive = false,
  onActiveChange,
  isPlaying = false,
  isLocalPaused = false,
  isMuted = false,
  volume = 1,
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
      onActiveChange?.(false);
    };
  }, [onActiveChange]);

  /** Reveal Bodrick after five clicks, excluding overlapping animations. */
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
    const phrase = pickNextBodrickPhrase({ isPlaying, isLocalPaused, isMuted, volume });
    setBodrick({ image: BODRICK_VARIANTS[phrase.variant], phrase: phrase.text });
    setBodrickPhase("entering");
    onActiveChange?.(true);
  };

  /** Keep the speech visible between the entrance and retreat animations. */
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
      onActiveChange?.(false);
    }
  };

  return (
    <button
      type="button"
      aria-label={t("main.touchHat")}
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
          <AssetImage src={bodrick.image} alt="" className={styles.bodrickImage} />
          {bodrickPhase === "shown" ? (
            <span className={styles.bodrickSpeech}>{bodrick.phrase}</span>
          ) : null}
        </span>
      ) : null}
      <AssetImage src={bodrickHat} alt="" className={styles.hatImage} priority />
    </button>
  );
}
