/**
 * Readmission backoff after resume or media transports fail for good. Spans about a
 * minute at most in scheduled waits; each retry samples 50–100% of its ceiling.
 */
export const READMIT_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 15000, 30000]);

/** Spread each retry across the upper half of its existing backoff window. */
export function retryDelay(maximumMs, random = Math.random) {
  return Math.round(maximumMs * (0.5 + random() * 0.5));
}
