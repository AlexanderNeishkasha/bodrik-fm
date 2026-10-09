/** Derive a bounded visual percentage without owning playback, gain, seek or persistence state. */
export function rangeProgress(value, min, max) {
  const lower = Number(min);
  const upper = Number(max);
  const current = Number(value);
  if (![lower, upper, current].every(Number.isFinite) || upper <= lower) return 0;
  return Math.round(Math.min(1, Math.max(0, (current - lower) / (upper - lower))) * 100);
}
