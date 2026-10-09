/** Peak level (0..1) above which a source counts as speaking. */
export const SPEAKING_THRESHOLD = 0.06;
/** How long speaking stays on after the level drops, so the ring doesn't flicker. */
export const SPEAKING_HOLD_MS = 600;
/** Sampling period for audio levels. */
const SAMPLE_MS = 120;

/** Next speaking state for one source: on above the threshold, off after the hold expires. */
export function nextSpeaking(lastLoudAt, level, now) {
  const loudAt = level >= SPEAKING_THRESHOLD ? now : lastLoudAt;
  return { loudAt, speaking: loudAt > 0 && now - loudAt <= SPEAKING_HOLD_MS };
}

/** Peak deviation of 8-bit time-domain samples, scaled to 0..1. */
export function peakLevel(data) {
  let peak = 0;
  for (const sample of data) peak = Math.max(peak, Math.abs(sample - 128) / 128);
  return peak;
}

/**
 * Measure live audio levels of every unpaused audio source in the registry and
 * report which participants are speaking right now. Muted (paused) sources never speak.
 */
export function createSpeakingMonitor(registry, { AudioContextImpl = globalThis.AudioContext, now = () => Date.now() } = {}) {
  const listeners = new Set();
  const meters = new Map();
  let context = null;
  let speaking = new Set();
  let timer = null;

  /** Attach analysers to new sources and drop those that vanished or paused. */
  function sync() {
    const live = registry.getSnapshot().sources.filter((source) => source.kind === "audio" && !source.paused);
    const ids = new Set(live.map((source) => source.id));
    for (const [id, meter] of meters) {
      if (!ids.has(id) || registry.getTrack(id) !== meter.track) {
        meter.node.disconnect();
        meters.delete(id);
      }
    }
    for (const source of live) {
      const track = registry.getTrack(source.id);
      if (meters.has(source.id) || !track || track.readyState === "ended") continue;
      context ||= new AudioContextImpl();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      const node = context.createMediaStreamSource(new MediaStream([track]));
      node.connect(analyser);
      meters.set(source.id, { track, node, analyser, participantId: source.participantId, loudAt: 0, data: new Uint8Array(analyser.fftSize) });
    }
  }

  /** Sample every meter and publish the speaking set when it changes. */
  function sample() {
    const time = now();
    const next = new Set();
    for (const meter of meters.values()) {
      meter.analyser.getByteTimeDomainData(meter.data);
      const state = nextSpeaking(meter.loudAt, peakLevel(meter.data), time);
      meter.loudAt = state.loudAt;
      if (state.speaking) next.add(meter.participantId);
    }
    if (next.size === speaking.size && [...next].every((id) => speaking.has(id))) return;
    speaking = next;
    for (const listener of [...listeners]) listener();
  }

  /** Start measuring; returns the cleanup that releases the audio context. */
  function start() {
    if (typeof AudioContextImpl !== "function" || typeof MediaStream === "undefined") return () => {};
    const unsubscribe = registry.subscribe(sync);
    sync();
    timer = setInterval(sample, SAMPLE_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
      for (const meter of meters.values()) meter.node.disconnect();
      meters.clear();
      context?.close().catch(() => {});
      context = null;
      speaking = new Set();
    };
  }

  return {
    start,
    /** Observe speaking-set changes. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Participant ids currently speaking. */
    getSnapshot: () => speaking,
  };
}
