export const MEETING_FADE_MS = 140;
export const MEETING_EXPAND_MS = 180;

/** Return staged presentation delays without delaying authoritative meeting state. */
export function meetingMotionPlan(enabled, reducedMotion = false) {
  if (reducedMotion) {
    return { mount: 0, expand: 0, reveal: 0, collapse: 0, unmount: 0 };
  }
  return enabled
    ? { mount: 0, expand: 0, reveal: MEETING_EXPAND_MS, collapse: null, unmount: null }
    : {
        mount: null,
        expand: null,
        reveal: null,
        collapse: MEETING_FADE_MS,
        unmount: MEETING_FADE_MS + MEETING_EXPAND_MS,
      };
}
