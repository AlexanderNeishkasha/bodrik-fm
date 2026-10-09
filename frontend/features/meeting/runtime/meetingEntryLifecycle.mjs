import { resolveMeetingInvitation } from "./meetingAdmission.mjs";
import { parseMeetingPath } from "./meetingRoute.mjs";

/** Initial immutable state for the static meeting entry. */
export const INITIAL_MEETING_ENTRY = Object.freeze({ phase: "loading", code: null, slug: null });

/**
 * Start one bounded invitation resolution and fence all work after disposal.
 *
 * The Next entry owns only this request. Signaling, capture and media remain inside the
 * single retained runtime after a successful prejoin transition.
 */
export function startMeetingEntry({ pathname, publish, resolve = resolveMeetingInvitation } = {}) {
  if (typeof publish !== "function") throw new TypeError("publish is required");
  if (pathname === "/meeting") return Object.freeze({ dispose() {} });
  const route = parseMeetingPath(pathname);
  let active = true;
  if (!route.valid) {
    queueMicrotask(() => {
      if (active) publish(Object.freeze({ phase: "error", code: "malformed", slug: null }));
    });
    return Object.freeze({ dispose() { active = false; } });
  }

  const controller = new AbortController();
  resolve({ slug: route.slug, signal: controller.signal })
    .then((state) => { if (active) publish(state); })
    .catch((error) => {
      if (active && error?.name !== "AbortError") {
        publish(Object.freeze({ phase: "error", code: "network", slug: null }));
      }
    });

  return Object.freeze({
    /** Abort the only pending request and fence stale completion. */
    dispose() {
      if (!active) return;
      active = false;
      controller.abort();
    },
  });
}
