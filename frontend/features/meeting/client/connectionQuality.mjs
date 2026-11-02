/** Poll slowly enough to avoid overlapping statistics requests. */
export const QUALITY_INTERVAL_MS = 2000;
/** Let a newly selected ICE route and its jitter buffer settle. */
const WARMUP_MS = 10000;
/** Background suspension and stale reports cannot establish continuous degradation. */
const MAX_SAMPLE_GAP_MS = 6000;
/** Require six seconds of independently updated, bad two-second windows. */
const BAD_WINDOWS = 3;
/** Sparse traffic, including Opus DTX, is not enough evidence for a route change. */
const MIN_PACKETS = 50;

/** Find the selected pair without retaining addresses or other ICE candidate details. */
function selectedPair(report) {
  const values = [...report.values()];
  const transport = values.find((item) => item.type === "transport" && item.selectedCandidatePairId);
  if (transport) return report.get(transport.selectedCandidatePairId);
  const pairs = values.filter((item) => item.type === "candidate-pair" && item.state === "succeeded" && (item.selected || item.nominated));
  return pairs.length === 1 ? pairs[0] : null;
}

/** Finite nonnegative counters; unavailable browser fields remain unknown. */
function counter(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reduce one RTP entry to the counters needed for this client's network leg. */
function streamSample(item, report, at) {
  const sending = item.type === "remote-inbound-rtp";
  if (!sending && item.type !== "inbound-rtp") return null;
  const local = sending ? report.get(item.localId) : item;
  const kind = local?.kind || local?.mediaType;
  if (!["audio", "video"].includes(kind) || local.active === false) return null;
  const codec = report.get(local.codecId)?.mimeType?.toLowerCase();
  if (codec?.endsWith("/rtx") || codec?.endsWith("/ulpfec")) return null;
  const packets = counter(sending ? local.packetsSent : item.packetsReceived);
  if (packets === null || !Number.isFinite(item.timestamp)) return null;
  return { kind, sending, packets, at, timestamp: item.timestamp,
    lost: Number.isFinite(item.packetsLost) ? item.packetsLost : null,
    fractionLost: counter(item.fractionLost),
    samples: counter(item.totalSamplesReceived), concealed: counter(item.concealedSamples),
    cpuLimited: local.qualityLimitationReason === "cpu" };
}

/** Classify one fresh interval; thresholds are initial product heuristics, not WebRTC limits. */
function poorInterval(previous, current, rtt) {
  const packets = current.packets - previous.packets;
  if (packets < 0 || current.at - previous.at > MAX_SAMPLE_GAP_MS) return null;
  const lost = current.lost !== null && previous.lost !== null ? Math.max(0, current.lost - previous.lost) : null;
  const total = current.sending ? packets : packets + (lost ?? 0);
  if (total < MIN_PACKETS) return null;
  const loss = current.sending ? current.fractionLost : lost === null ? null : lost / total;
  if (loss === null || loss > 1) return null;
  if (current.kind === "audio") {
    if (loss >= 0.08) return "packet-loss";
    const samples = current.samples !== null && previous.samples !== null ? current.samples - previous.samples : 0;
    const concealed = current.concealed !== null && previous.concealed !== null ? current.concealed - previous.concealed : 0;
    if (loss >= 0.03 && samples >= 24000 && concealed / samples >= 0.1) return "audio-concealment";
    if (loss >= 0.03 && rtt !== null && rtt >= 0.6) return "loss-and-latency";
  } else if (!current.cpuLimited && (loss >= 0.2 || (loss >= 0.1 && rtt !== null && rtt >= 0.4))) {
    return "video-packet-loss";
  }
  return null;
}

/** Track only recent counters and sustained degradation on one selected direct route. */
export function createQualityTracker() {
  let route = null;
  let routeSince = 0;
  let lastPoll = null;
  let previous = new Map();
  const streaks = new Map();

  /** Discard evidence after an unavailable/disconnected transport or an interrupted poll. */
  function reset() {
    route = null;
    lastPoll = null;
    previous.clear();
    streaks.clear();
  }

  return {
    reset,
    /** Return a credential-free reason only after fresh, consecutive bad reports. */
    sample(report, at) {
      const pair = selectedPair(report);
      const candidate = pair && report.get(pair.localCandidateId);
      if (!pair || pair.state !== "succeeded" || !["host", "srflx", "prflx"].includes(candidate?.candidateType)) {
        reset();
        return null;
      }
      if (route !== pair.id || lastPoll === null || at <= lastPoll || at - lastPoll > MAX_SAMPLE_GAP_MS) {
        reset();
        route = pair.id;
        routeSince = at;
      }
      lastPoll = at;
      const next = new Map();
      let decision = null;
      for (const item of report.values()) {
        const current = streamSample(item, report, at);
        if (!current) continue;
        const old = previous.get(item.id);
        if (old && current.timestamp === old.timestamp) {
          next.set(item.id, old);
          if (at - old.at > MAX_SAMPLE_GAP_MS) streaks.delete(item.id);
          continue;
        }
        next.set(item.id, current);
        const reason = old && current.timestamp > old.timestamp && at - routeSince >= WARMUP_MS
          ? poorInterval(old, current, counter(pair.currentRoundTripTime)) : null;
        if (!reason) {
          streaks.delete(item.id);
          continue;
        }
        const count = (streaks.get(item.id) || 0) + 1;
        streaks.set(item.id, count);
        if (count >= BAD_WINDOWS) decision = { reason, kind: current.kind, direction: current.sending ? "send" : "receive" };
      }
      previous = next;
      for (const id of streaks.keys()) if (!next.has(id)) streaks.delete(id);
      return decision;
    },
  };
}

/** Own one non-overlapping polling loop; disposal fences late getStats resolutions. */
export function createQualityMonitor({ transports, onPoorQuality, setTimer = setTimeout, clearTimer = clearTimeout,
  now = Date.now, onError = (error) => console.warn("Meeting connection statistics unavailable", error) }) {
  let closed = false;
  let timer = null;
  const entries = transports.map((transport) => ({ transport, tracker: createQualityTracker(), warned: false }));

  /** Poll both local network legs without coupling a failed statistics request to media recovery. */
  async function poll() {
    timer = null;
    const reports = await Promise.allSettled(entries.map(async ({ transport }) => transport.getStats()));
    if (closed) return;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const report = reports[index];
      if (report.status === "rejected" || entry.transport.closed || entry.transport.connectionState !== "connected") {
        entry.tracker.reset();
        if (report.status === "rejected" && !entry.warned) {
          entry.warned = true;
          onError(report.reason);
        }
        continue;
      }
      entry.warned = false;
      const decision = entry.tracker.sample(report.value, now());
      if (!decision) continue;
      closed = true;
      onPoorQuality(decision);
      return;
    }
    if (!closed) timer = setTimer(poll, QUALITY_INTERVAL_MS);
  }

  if (entries.every(({ transport }) => typeof transport.getStats === "function")) timer = setTimer(poll, QUALITY_INTERVAL_MS);
  return {
    /** Cancel the sole timer and ignore all pending statistics after media teardown. */
    close() { closed = true; if (timer !== null) clearTimer(timer); },
  };
}
