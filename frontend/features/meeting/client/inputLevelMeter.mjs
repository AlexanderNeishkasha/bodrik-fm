/** Analyse the current capture track while views listen, following device and processing replacements. */
export function createInputLevelMeter({ capture, AudioContextImpl = globalThis.AudioContext, MediaStreamImpl = globalThis.MediaStream, schedule = setInterval, cancel = clearInterval }) {
  const listeners = new Set();
  let level = 0;
  let meter = null;
  let offCapture = null;
  /** Publish a shared observed level to both microphone meter views. */
  function publish(value) {
    level = value;
    for (const listener of [...listeners]) listener();
  }
  /** Release only the analyser resources; capture owns the live call track. */
  function stop() {
    if (meter) {
      cancel(meter.timer);
      meter.source.disconnect();
      meter.analyser.disconnect();
      meter.context.close().catch((error) => console.warn("Microphone meter cleanup failed", error));
      meter = null;
    }
    publish(0);
  }
  /** Replace the analyser when capture replaces or removes its microphone track. */
  function sync() {
    const track = capture.track("audio");
    if (meter?.track === track) return;
    stop();
    if (!listeners.size || !track || typeof AudioContextImpl !== "function" || typeof MediaStreamImpl !== "function") return;
    const context = new AudioContextImpl();
    try {
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      const source = context.createMediaStreamSource(new MediaStreamImpl([track]));
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const timer = schedule(() => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const sample of data) peak = Math.max(peak, Math.abs(sample - 128) / 128);
        publish(Math.min(1, peak * 1.5));
      }, 100);
      meter = { track, context, analyser, source, timer };
      if (context.state === "suspended") context.resume().catch((error) => {
        if (meter?.context === context) console.warn("Microphone meter resume failed", error);
      });
    } catch (error) {
      context.close().catch((failure) => console.warn("Microphone meter cleanup failed", failure));
      console.warn("Microphone meter initialization failed", error);
    }
  }
  return {
    getSnapshot: () => level,
    /** Share one analyser across subscribers and observe track replacements while needed. */
    subscribe(listener) {
      listeners.add(listener);
      if (!offCapture) offCapture = capture.subscribe(sync);
      sync();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { offCapture?.(); offCapture = null; stop(); }
      };
    },
    /** Release the capture subscription and analyser when the meeting ends. */
    dispose() { offCapture?.(); offCapture = null; listeners.clear(); stop(); },
  };
}
