/** Compare raw microphone levels using menu-owned captures, one context and one sampling timer. */
export function createMicrophoneComparison({ capture, mediaDevices = globalThis.navigator?.mediaDevices, AudioContextImpl = globalThis.AudioContext, schedule = setInterval, cancel = clearInterval }) {
  const listeners = new Set();
  const entries = new Map();
  let snapshot = Object.freeze({});
  let session = null;
  /** Publish only changed levels/status, keeping external-store snapshots stable between samples. */
  function publish() {
    const next = Object.fromEntries([...entries].map(([id, entry]) => [id, { level: entry.level, status: entry.status }]));
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  }
  /** Stop only comparison-owned tracks and detach their analyser graph. */
  function release(entry) {
    entry.source?.disconnect();
    entry.analyser?.disconnect();
    for (const track of entry.stream?.getTracks() || []) track.stop();
    entry.stream = null;
    entry.source = null;
    entry.analyser = null;
  }
  /** Open an exact device; a late permission result is stopped if the menu/device is gone. */
  async function acquire(id, entry, owner) {
    let stream;
    try {
      stream = await mediaDevices.getUserMedia({ video: false, audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (session !== owner || entries.get(id) !== entry) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      entry.stream = stream;
      entry.analyser = owner.context.createAnalyser();
      entry.analyser.fftSize = 256;
      entry.source = owner.context.createMediaStreamSource(stream);
      entry.source.connect(entry.analyser);
      entry.data = new Uint8Array(entry.analyser.fftSize);
      entry.status = "ready";
      publish();
    } catch (error) {
      if (session !== owner || entries.get(id) !== entry) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      release(entry);
      entry.analyser = null;
      entry.status = "unavailable";
      publish();
      console.warn("Microphone comparison unavailable", id, error.name);
    }
  }
  /** Add/remove only changed device IDs; selecting a call microphone does not restart comparison. */
  function sync() {
    const devices = capture.getSnapshot().inputDevices;
    const ids = new Set(devices.map((device) => device.value));
    for (const [id, entry] of entries) {
      if (!ids.has(id)) { release(entry); entries.delete(id); }
    }
    for (const id of ids) {
      if (entries.has(id)) continue;
      const entry = { level: 0, status: session?.context ? "pending" : "unavailable" };
      entries.set(id, entry);
      if (session?.context) void acquire(id, entry, session);
    }
    publish();
  }
  /** Acquire comparison resources only while at least one visible menu subscribes. */
  function start() {
    const owner = {};
    session = owner;
    try {
      if (typeof AudioContextImpl === "function" && mediaDevices?.getUserMedia) owner.context = new AudioContextImpl();
    } catch (error) { console.warn("Microphone comparison initialization failed", error.name); }
    owner.off = capture.subscribe(sync);
    sync();
    if (owner.context) {
      owner.context.resume?.().catch((error) => {
        if (session === owner) console.warn("Microphone comparison resume failed", error.name);
      });
      owner.timer = schedule(() => {
        for (const entry of entries.values()) {
          if (entry.status !== "ready") continue;
          entry.analyser.getByteTimeDomainData(entry.data);
          let peak = 0;
          for (const value of entry.data) peak = Math.max(peak, Math.abs(value - 128) / 128);
          entry.level = Math.min(1, peak * 1.5);
        }
        publish();
      }, 100);
    }
  }
  /** Cancel pending captures, close the context and stop all owned streams on menu close. */
  function stop() {
    const owner = session;
    session = null;
    if (!owner) return;
    owner.off();
    if (owner.timer !== undefined) cancel(owner.timer);
    for (const entry of entries.values()) release(entry);
    entries.clear();
    owner.context?.close().catch((error) => console.warn("Microphone comparison cleanup failed", error.name));
    publish();
  }
  return {
    getSnapshot: () => snapshot,
    /** Start on mount and release after the last menu subscriber leaves, including Strict Mode cleanup. */
    subscribe(listener) {
      listeners.add(listener);
      if (!session) start();
      return () => { listeners.delete(listener); if (!listeners.size) stop(); };
    },
    /** Explicitly end the comparison when its owning session is disposed. */
    dispose() { listeners.clear(); stop(); },
  };
}
