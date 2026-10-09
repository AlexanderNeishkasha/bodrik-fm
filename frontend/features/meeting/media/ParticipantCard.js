import { useRef } from "react";
import { Crown } from "lucide-react";

import Icon from "../../../components/ui/Icon";
import MediaTrack from "./MediaTrack";
import ParticipantAvatar from "./ParticipantAvatar";
import styles from "./MediaRegistryView.module.css";

/** Render one stable participant identity from display-safe source observations. */
export default function ParticipantCard({ registry, participant, sources, className, cardKey, focused = false, onActivate, activateLabel, transitionName, children }) {
  const lastTap = useRef(null);
  const pointerType = useRef("");
  const visibleSources = sources.filter((source) => source.kind !== "audio" && !source.paused);
  // Speaking is shown as an accent ring around the card rather than a text label.
  const classes = [styles.card, participant.speaking ? styles.speaking : "", className || ""].filter(Boolean).join(" ");
  /** Double click (or Enter/Space) on the card itself toggles participant focus. */
  const activate = (event) => {
    if (!onActivate || event.target.closest("button, input, select, textarea, a, [role=menu], label")) return;
    if (event.type === "dblclick" && pointerType.current === "touch") return;
    if (event.type === "keydown") {
      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
    }
    onActivate();
  };
  /** Focus the card element to reveal its corner controls without changing the layout. */
  const revealControls = (event) => {
    if (pointerType.current !== "touch") return;
    if (event.target.closest("button, input, select, textarea, a, [role=menu], label")) return;
    event.currentTarget.focus({ preventScroll: true });
  };
  /** Recognize nearby touch taps; browsers do not consistently emit touch dblclick. */
  const tap = (event) => {
    if (event.pointerType !== "touch" || event.target.closest("button, input, select, textarea, a, [role=menu], label")) {
      lastTap.current = null;
      return;
    }
    const previous = lastTap.current;
    lastTap.current = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    if (previous && event.timeStamp - previous.time <= 350 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 24) {
      lastTap.current = null;
      onActivate?.();
    }
  };
  return <article className={classes} data-speaking={participant.speaking ? "true" : undefined} data-participant-id={participant.id} data-card-key={cardKey || participant.id}
    style={transitionName ? { viewTransitionName: transitionName } : undefined} data-focused={focused ? "true" : undefined} tabIndex={onActivate ? 0 : undefined} aria-label={onActivate && activateLabel ? `${participant.name}: ${activateLabel}` : undefined}
    onPointerDown={(event) => { pointerType.current = event.pointerType; }} onPointerUp={onActivate ? tap : undefined}
    onPointerCancel={() => { lastTap.current = null; }}
    onClick={onActivate ? revealControls : undefined} onDoubleClick={onActivate ? activate : undefined} onKeyDown={onActivate ? activate : undefined}>
    <div className={styles.media}>
      {visibleSources.map((source) => <MediaTrack key={source.id} registry={registry} source={source} />)}
      {/* Capture avatars separately so tall-to-wide card snapshots do not magnify them. */}
      {visibleSources.length === 0 && <div className={styles.avatar} style={transitionName ? { viewTransitionName: `${transitionName}-avatar` } : undefined}><ParticipantAvatar participant={participant} /></div>}
      {/* The retained runtime remains the sole audio renderer until volume ownership moves. */}
    </div>
    <footer className={styles.footer}>
      {participant.presenter && <span className={styles.presenter} role="img" aria-label="Ведущий" title="Ведущий"><Crown size={14} /></span>}
      <strong>{participant.bot ? "Бодрик FM" : participant.name}</strong>
      {!participant.bot && <span className={participant.audio ? styles.microphone : styles.microphoneMuted} role="img" aria-label={participant.audio ? "Микрофон включён" : "Микрофон выключен"}>
        <Icon name="mic" />
      </span>}
    </footer>
    {children}
  </article>;
}
