/** Normalize frequency energy into the existing perceptual pulse curve. */
export function pulseTarget(analyser, data) {
  analyser.getByteFrequencyData(data);
  let sum = 0;
  for (const value of data) sum += value * value;
  const rms = Math.sqrt(sum / data.length) / 255;
  const gated = rms < 0.01 ? 0 : rms;
  const boosted = Math.min(1, Math.pow(gated, 0.6) * (gated < 0.1 ? 1.2 : 1));
  return boosted * boosted * (3 - 2 * boosted);
}

/** Preserve 60 Hz attack/decay timing at any sampling rate, with quicker idle settling. */
export function smoothPulse(level, target, elapsedMs, idle = false) {
  const rate = idle ? 0.2 : target > level ? 0.06 : 0.03;
  const fraction = 1 - Math.pow(1 - rate, Math.max(0, elapsedMs) / (1000 / 60));
  return Math.min(1, Math.max(0, level + (target - level) * fraction));
}
