import assert from "node:assert/strict";
import { test } from "node:test";
import { retryDelay } from "../features/meeting/client/retryDelay.mjs";

for (const [name, maximum, sample, expected] of [
  ["first resume minimum", 500, 0, 250],
  ["first resume maximum", 500, 1, 500],
  ["intermediate sample", 2000, 0.5, 1500],
  ["readmission cap", 30000, 1, 30000],
  ["readmission minimum", 30000, 0, 15000],
]) {
  test(name, () => assert.equal(retryDelay(maximum, () => sample), expected));
}

test("different samples spread retries without expanding the existing windows", () => {
  for (const maximum of [500, 1000, 1500, 2500, 3500, 2000, 4000, 8000, 15000, 30000]) {
    const delays = [0, 0.25, 0.5, 0.75, 0.999].map(sample => retryDelay(maximum, () => sample));
    assert.equal(new Set(delays).size, delays.length);
    assert.ok(delays.every(delay => delay >= maximum / 2 && delay <= maximum));
  }
});
