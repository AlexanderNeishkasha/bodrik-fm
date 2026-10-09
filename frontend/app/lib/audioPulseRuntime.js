import { pulseTarget, smoothPulse } from "./audioPulseMath";

const audioGraphs = new WeakMap();
/** Reuse a media source: browsers permit only one per audio element. */
function getAudioGraph(element, AudioContextCtor) {
  let graph = audioGraphs.get(element);
  if (!graph) {
    const ctx = new AudioContextCtor();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    const source = ctx.createMediaElementSource(element);
    source.connect(analyser);
    analyser.connect(ctx.destination);
    graph = { ctx, analyser };
    // Media owns the graph's lifetime, independently of mounted visualizers.
    // A retained source must resume even if pulse rendering has been disabled.
    /** Resume the retained media path when this element actually plays. */
    const resume = () => { ctx.resume().catch(() => {}); };
    /** Sleep after playback stops, including after the visualizer unmounts. */
    const suspend = () => { if (element.paused || element.ended) ctx.suspend().catch(() => {}); };
    element.addEventListener("play", resume);
    element.addEventListener("playing", resume);
    element.addEventListener("pause", suspend);
    element.addEventListener("ended", suspend);
    audioGraphs.set(element, graph);
  }
  return graph;
}

/** Own visual scheduling, never interrupting the element's background audio path. */
export default function runAudioPulse({ enabled = true, unlocked = false, scope = window }) {
  const doc = scope.document;
  let audio = null;
  let target = null;
  let graph = null;
  let timer = null;
  let level = 0;
  let previousTime = null;
  let lastValue = "";
  let disposed = false;
  let gesture = unlocked;
  const data = new Uint8Array(128);

  /** Write only changed, quantized values on the panel, not the document root. */
  const write = () => {
    const value = level.toFixed(3);
    if (target && value !== lastValue) {
      target.style.setProperty("--audio-pulse", value);
      lastValue = value;
    }
  };
  /** Cancel the owned timeout; hidden tabs have no visual work to settle. */
  const stop = () => {
    if (timer !== null) scope.clearTimeout(timer);
    timer = null;
    previousTime = null;
  };
  /** Attach the graph only after a gesture and resume within that event's turn. */
  const ensureGraph = () => {
    if (!audio || audio.paused || audio.ended || !gesture || !enabled) return;
    const Ctor = scope.AudioContext || scope.webkitAudioContext;
    if (!Ctor) return;
    try {
      graph = getAudioGraph(audio, Ctor);
      if (graph.ctx.state === "suspended") graph.ctx.resume().catch(() => {});
    } catch {
      // Playback can continue without a visualizer when Web Audio is unavailable.
      graph = null;
    }
  };
  /** Sample at most 30 Hz; paused/muted elements settle to zero and stop. */
  const tick = () => {
    timer = null;
    if (disposed || doc.hidden || !enabled) return;
    const now = scope.performance.now();
    const elapsed = previousTime === null ? 1000 / 30 : now - previousTime;
    previousTime = now;
    const active = graph && audio && !audio.paused && !audio.ended && !audio.muted && audio.volume !== 0;
    const desired = active ? pulseTarget(graph.analyser, data) : 0;
    level = smoothPulse(level, desired, elapsed, !active);
    if (!active && level < 0.0005) level = 0;
    write();
    if (active || level > 0) timer = scope.setTimeout(tick, 1000 / 30);
    else previousTime = null;
  };
  /** Start or settle visual work in response to playback and volume changes. */
  const wake = () => {
    if (disposed) return;
    ensureGraph();
    if (doc.hidden || !enabled) {
      stop();
      level = 0;
      write();
    } else if (timer === null) tick();
  };
  /** Unlock Web Audio from a user gesture without starting paused playback. */
  const unlock = () => { gesture = true; wake(); };
  const events = ["play", "playing", "pause", "ended", "volumechange", "emptied"];
  doc.addEventListener("visibilitychange", wake);
  scope.addEventListener("bodrik_fm_audio_pulse_unlock", unlock);
  scope.addEventListener("pointerdown", unlock, { passive: true });
  scope.addEventListener("keydown", unlock);

  /** A removed media element must not keep playing through its retained graph. */
  const releaseDetached = () => {
    if (audio?.isConnected === false) audio.pause();
  };

  return {
    /** Bind the committed audio element explicitly, including conditional mounts. */
    bind(element) {
      if (disposed || element === audio) return;
      releaseDetached();
      stop();
      for (const event of events) audio?.removeEventListener(event, wake);
      if (target) target.style.setProperty("--audio-pulse", "0");
      // A removed/paused element may sleep; a playing element must remain audible.
      if (audio?.paused) graph?.ctx.suspend?.().catch(() => {});
      audio = element;
      graph = null;
      target = audio?.closest(".audio-glow-hero, .audio-glow-card") || null;
      level = 0;
      lastValue = "";
      for (const event of events) audio?.addEventListener(event, wake);
      wake();
    },
    /** Release listeners and scheduling while leaving background audio connected. */
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseDetached();
      stop();
      for (const event of events) audio?.removeEventListener(event, wake);
      doc.removeEventListener("visibilitychange", wake);
      scope.removeEventListener("bodrik_fm_audio_pulse_unlock", unlock);
      scope.removeEventListener("pointerdown", unlock);
      scope.removeEventListener("keydown", unlock);
      if (audio?.paused) graph?.ctx.suspend?.().catch(() => {});
      level = 0;
      write();
      audio = null;
      graph = null;
      target = null;
    },
  };
}
