"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { flushAndSettle, withViewTransition } from "./cardMotion.mjs";

/**
 * The cards to render, lagging the live list by one View Transition: when someone
 * joins or leaves, the switch to the new list runs inside `startViewTransition`, so
 * cards glide to their new places and arrivals/departures fade (see meetingTheme CSS).
 * A departed card is drawn from its last known data until the switch happens.
 */
export function useAnimatedCards(cards) {
  const signature = cards.map((card) => card.key).join(" ");
  const [shown, setShown] = useState(signature);
  // Card data by key, refreshed whenever the card set changes, so departed cards can
  // still render until the switch; `set` records which card set it was built for.
  const [known, setKnown] = useState(() => ({ set: signature, cards: new Map(cards.map((card) => [card.key, card])) }));

  if (known.set !== signature) {
    // Card set changed: remember the new cards too (React's "adjust state on prop change").
    // Keep only live cards plus those still on screen (departing), so memory stays bounded.
    const next = new Map(cards.map((card) => [card.key, card]));
    for (const key of shown ? shown.split(" ") : []) if (!next.has(key) && known.cards.has(key)) next.set(key, known.cards.get(key));
    setKnown({ set: signature, cards: next });
  }

  useEffect(() => {
    if (signature === shown) return;
    // The browser runs the update callback later, outside React's lifecycle, where
    // flushSync is allowed; settling covers the grid re-measuring its tiles.
    withViewTransition(() => setShown(signature), flushAndSettle(flushSync));
  }, [signature, shown]);

  const live = new Map(cards.map((card) => [card.key, card]));
  return (shown ? shown.split(" ") : []).map((key) => live.get(key) || known.cards.get(key)).filter(Boolean);
}
