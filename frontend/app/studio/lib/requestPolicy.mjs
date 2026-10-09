/** Advance the monotonic identity for one debounced Studio draft. */
export function nextDraftRevision(current) {
  return Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
}

/** Return whether asynchronous work still owns the latest draft revision. */
export function ownsDraftRevision(current, expected) {
  return current === expected;
}

/** Clamp a finite conference volume or reject malformed input. */
export function normalizeConferenceVolume(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : null;
}
