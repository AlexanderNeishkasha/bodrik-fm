import { READMIT_DELAYS_MS, retryDelay } from "./retryDelay.mjs";

/**
 * Own replaceable media and the per-call TURN latch. Quality recovery keeps the admitted
 * session; full readmission remains the fallback for signaling/native failures.
 */
export function createMediaRecovery({ createMedia, session, local, getState, dispatch, outgoing, publish, enterMedia, refresh,
  getRetryChoice, setRetryChoice, isLeaving, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
  let forceRelay = false;
  let active = false;
  let media = createMedia({ forceRelay });
  let retryTimer = null;
  let finishDelay = null;
  let restoring = null;

  /** Own the single readmission delay so explicit leave can release it immediately. */
  function wait(ms) {
    return new Promise((resolve) => {
      finishDelay = resolve;
      retryTimer = setTimer(() => { retryTimer = null; finishDelay = null; resolve(); }, ms);
    });
  }

  /** Retain source kinds and mute state while capture continues to own the tracks. */
  function liveSources() {
    return [...local.entries()].map(([kind, id]) => ({ kind, paused: getState().producers[id]?.paused === true }));
  }

  /** Remove obsolete producer ids before their replacement is published. */
  function clearSources() {
    for (const id of local.values()) dispatch({ type: "localProducerClosed", id });
    local.clear();
  }

  /** Republish retained capture without requesting devices or screen-share permission again. */
  async function restore(live) {
    for (const { kind, paused } of live) {
      if (isLeaving()) return;
      const track = outgoing(kind);
      if (track && track.readyState !== "ended") await publish(kind, track, paused);
    }
  }

  /** Re-admit with bounded jittered retries after an unrecoverable media or signaling failure. */
  async function readmit(retained) {
    if (isLeaving() || active) return;
    setRetryChoice(getRetryChoice());
    active = true;
    const live = retained || liveSources();
    restoring = live;
    dispatch({ type: "status", status: "reconnecting" });
    clearSources();
    media.close();
    try {
      await session.leave().catch(() => {});
      for (const delay of READMIT_DELAYS_MS) {
        if (isLeaving()) return;
        await wait(retryDelay(delay, random));
        if (isLeaving()) return;
        media = createMedia({ forceRelay });
        try {
          await session.connect();
          if (getState().status !== "admitted") return;
          await enterMedia();
          await restore(live);
          if (isLeaving()) return;
          await refresh();
          setRetryChoice(null);
          return;
        } catch {
          media.close();
          await session.leave().catch(() => {});
        }
      }
      if (!isLeaving()) dispatch({ type: "status", status: "failed" });
    } finally {
      active = false;
      restoring = null;
    }
  }

  return {
    /** The sole current media owner, replaced only by this recovery coordinator. */
    get media() { return media; },
    /** Suppress obsolete signaling status changes during either recovery path. */
    get active() { return active; },
    /** Apply a mute change received while producer ids are temporarily absent. */
    setPaused(kind, paused) {
      const source = restoring?.find((value) => value.kind === kind);
      if (!source) return false;
      source.paused = paused;
      return true;
    },
    /** Read the latest retained mute decision after an asynchronous publish completes. */
    pausedFor(kind, fallback) { return restoring?.find((value) => value.kind === kind)?.paused ?? fallback; },
    /** Dispose the current media and cancel any pending readmission delay on explicit leave. */
    close() {
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      finishDelay?.();
      finishDelay = null;
      media.close();
    },
    readmit,
    /** Switch once to TURN/TLS, preserving session identity, roles and live source mute state. */
    async useRelay() {
      if (isLeaving() || active || forceRelay) return;
      forceRelay = true;
      setRetryChoice(getRetryChoice());
      active = true;
      const live = liveSources();
      restoring = live;
      dispatch({ type: "status", status: "reconnecting" });
      clearSources();
      let failed = false;
      try {
        await media.closeTransports();
        if (isLeaving()) return;
        media = createMedia({ forceRelay });
        await media.start();
        if (isLeaving()) return;
        await restore(live);
        if (isLeaving()) return;
        await refresh();
        if (!isLeaving()) dispatch({ type: "status", status: "admitted" });
        setRetryChoice(null);
      } catch {
        failed = true;
      } finally {
        active = false;
        restoring = null;
      }
      if (failed && !isLeaving()) await readmit(live);
    },
  };
}
