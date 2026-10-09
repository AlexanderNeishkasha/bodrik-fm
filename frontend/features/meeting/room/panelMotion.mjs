import { flushSync } from "react-dom";

import { flushAndSettle, withViewTransition } from "./cardMotion.mjs";

/** Animate sidebar visibility and settle the participant grid before taking the new snapshot. */
export function transitionPanel(change) {
  withViewTransition(change, flushAndSettle(flushSync));
}
