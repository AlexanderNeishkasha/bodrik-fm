"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

import ParticipantCard from "../media/ParticipantCard";
import { createSpeakingMonitor } from "../media/speakingMonitor.mjs";
import CardActions, { CARD_COPY } from "./CardActions";
import { buildCards, fitTiles, focusedCard, newScreenKeys } from "./gridLayout.mjs";
import { flushAndSettle, RELAYOUT_EVENT, transitionName, withViewTransition } from "./cardMotion.mjs";
import { useAnimatedCards } from "./useAnimatedCards";
import styles from "./MeetingGrid.module.css";

/** Meeting card grid driven by the media registry and the viewer's local layout. */
export default function MeetingGrid({ registry, layout, participants, selfId, presenter = false, language = "ru", hideCameraOff = false, loaded = true }) {
  const text = { ...CARD_COPY[language === "en" ? "en" : "ru"], region: language === "en" ? "Meeting participants" : "Участники встречи" };
  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const membershipKey = snapshot.participants.map((peer) => peer.id).sort().join(",");
  const view = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot);
  // "Camera-off participants" off: only self, the music bot and people with video stay in the grid.
  const shown = snapshot.participants.filter((value) => !view.hidden.includes(value.id) &&
    (!hideCameraOff || value.id === selfId || value.bot || value.video || value.screen));
  const speaking = useSpeaking(registry);
  // Speaking comes from live audio levels; the server's dominant speaker stays on the last talker.
  const liveCards = buildCards(shown.map((value) => ({ ...value, speaking: !value.bot && speaking.has(value.id) })), snapshot.sources);
  // Joins and leaves switch the rendered list inside a View Transition.
  const cards = useAnimatedCards(liveCards);
  // One mode: the grid, or one focused card large with the others in a strip. Double clicking a
  // card focuses it (again: back to the grid); a newly started screen share takes focus.
  const focus = focusedCard(cards, view.pinned);
  const areaRef = useTileLayout(focus ? 0 : cards.length);
  const settling = useSettling(loaded);
  useScreenShareFocus(liveCards, layout);

  /** Focus a card, or return to the grid when it is already focused (smoothly where supported). */
  const toggleFocus = (key) => withViewTransition(() => layout.pin(focus?.key === key ? "" : key), flushAndSettle(flushSync));

  /** Render one card with its sources and actions. */
  const render = (value) => <ParticipantCard key={value.key} registry={registry} participant={value.participant} cardKey={value.key}
    sources={value.sources} focused={focus?.key === value.key} transitionName={transitionName(value.key)} onActivate={() => toggleFocus(value.key)} activateLabel={focus?.key === value.key ? text.unfocus : text.focus}>
    <CardActions key={membershipKey} card={value} layout={layout} participants={participants} selfId={selfId} presenter={presenter} text={text} />
  </ParticipantCard>;

  // Keyed slots keep cards under the same parent in every mode; only placement changes.
  let stripColumn = 0;
  return <div className={styles.stage}>
    <section ref={areaRef} className={`${styles.layout} ${focus ? styles.speaker : styles.grid}`} data-view={focus ? "speaker" : "grid"}
      aria-label={text.region} data-settling={settling ? "" : undefined} style={{ "--strip-count": Math.max(1, cards.length - 1) }}>
      {cards.map((value) => {
        const isFocused = focus?.key === value.key;
        const column = focus && !isFocused ? ++stripColumn : undefined;
        return <div key={value.key} className={`${styles.slot} ${isFocused ? styles.focus : ""}`}
          style={column ? { gridColumn: column, gridRow: 2 } : undefined}>
          {render(value)}
        </div>;
      })}
    </section>
  </div>;
}

/** Show the grid anyway after this long, if the initial inventory is slow or fails. */
const SETTLE_MAX_MS = 1500;

/**
 * True right after joining until the room's initial cards are known (`loaded`), so the
 * grid fades in once instead of showing the interim "alone" layout.
 */
function useSettling(loaded) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), SETTLE_MAX_MS);
    return () => clearTimeout(timer);
  }, []);
  return !loaded && !expired;
}

/** Give focus to a screen share when it starts; with several, later clicks decide. */
function useScreenShareFocus(cards, layout) {
  const seen = useRef(null);
  // A stable string of the screen-card keys, so the effect runs only when shares change.
  const keys = cards.filter((card) => card.screen).map((card) => card.key).join(" ");
  useEffect(() => {
    // Card keys contain no spaces ("<participant>:<source>").
    const current = keys ? keys.split(" ").map((key) => ({ key, screen: true })) : [];
    // The first render only records existing shares; it does not steal focus on join.
    if (seen.current) {
      const started = newScreenKeys(seen.current, current);
      if (started.length) withViewTransition(() => layout.pin(started.at(-1)), flushAndSettle(flushSync));
    }
    seen.current = new Set(current.map((card) => card.key));
  }, [keys, layout]);
}

/** Grid padding and gap in pixels; must match MeetingGrid.module.css. */
const GRID_PADDING = 12;
const GRID_GAP = 12;

/**
 * Fit equal tiles to the grid and write their size as CSS variables on the grid
 * element. It runs on window/panel resizes (ResizeObserver) and after every commit
 * (layout effect), so a change applied with flushSync, such as a panel opening inside
 * a View Transition, is re-tiled before the transition's "after" snapshot.
 */
function useTileLayout(count) {
  const [element, setElement] = useState(null);
  const tiles = useRef(count);
  useEffect(() => {
    if (!element || typeof ResizeObserver !== "function") return undefined;
    const relayout = () => applyTiles(element, tiles.current);
    const observer = new ResizeObserver(relayout);
    observer.observe(element);
    window.addEventListener(RELAYOUT_EVENT, relayout);
    return () => {
      observer.disconnect();
      window.removeEventListener(RELAYOUT_EVENT, relayout);
    };
  }, [element]);
  useLayoutEffect(() => {
    tiles.current = count;
    if (element) applyTiles(element, count);
  });
  return setElement;
}

/** Measure the grid and set --tile-width/--tile-height for `count` tiles. */
function applyTiles(element, count) {
  const { width, height } = element.getBoundingClientRect();
  const padding = parseFloat(getComputedStyle(element).paddingLeft) || GRID_PADDING;
  element.style.setProperty("--focus-width", `${Math.max(0, width - padding * 2)}px`);
  const tile = fitTiles(count, width - padding * 2, height - padding * 2, GRID_GAP);
  if (tile.width <= 0) return;
  element.style.setProperty("--tile-width", `${tile.width}px`);
  element.style.setProperty("--tile-height", `${tile.height}px`);
}

/** Participant ids whose audio is currently above the speaking threshold. */
function useSpeaking(registry) {
  const [monitor] = useState(() => createSpeakingMonitor(registry));
  useEffect(() => monitor.start(), [monitor]);
  return useSyncExternalStore(monitor.subscribe, monitor.getSnapshot, monitor.getSnapshot);
}
