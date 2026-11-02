/** Synthetic getStats report for a single direct/relay leg; contains no network addresses. */
export function qualityReport({ time = 0, received = 0, lost = 0, kind = "audio", sending = false, rtt = 0.1,
  candidateType = "host", route = "pair", samples = 0, concealed = 0, fractionLost = 0.1, cpu = false } = {}) {
  const values = [
    { id: "transport", type: "transport", selectedCandidatePairId: route },
    { id: route, type: "candidate-pair", state: "succeeded", localCandidateId: "candidate", currentRoundTripTime: rtt },
    { id: "candidate", type: "local-candidate", candidateType },
    sending
      ? { id: "local", type: "outbound-rtp", kind, packetsSent: received + lost, active: true, qualityLimitationReason: cpu ? "cpu" : "none" }
      : { id: "stream", type: "inbound-rtp", kind, timestamp: time, packetsReceived: received, packetsLost: lost,
        totalSamplesReceived: samples, concealedSamples: concealed },
  ];
  if (sending) values.push({ id: "stream", type: "remote-inbound-rtp", localId: "local", timestamp: time, packetsLost: lost, fractionLost });
  return new Map(values.map((value) => [value.id, value]));
}
