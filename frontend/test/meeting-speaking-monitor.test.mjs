import assert from "node:assert/strict";
import test from "node:test";

import { SPEAKING_HOLD_MS, SPEAKING_THRESHOLD, nextSpeaking, peakLevel } from "../features/meeting/media/speakingMonitor.mjs";

const cases = [
  { name: "silence never speaks", lastLoudAt: 0, level: 0, now: 1000, speaking: false, loudAt: 0 },
  { name: "loud input speaks", lastLoudAt: 0, level: SPEAKING_THRESHOLD, now: 1000, speaking: true, loudAt: 1000 },
  { name: "brief pause keeps speaking", lastLoudAt: 1000, level: 0, now: 1000 + SPEAKING_HOLD_MS, speaking: true, loudAt: 1000 },
  { name: "silence after the hold stops speaking", lastLoudAt: 1000, level: 0, now: 1001 + SPEAKING_HOLD_MS, speaking: false, loudAt: 1000 },
];

for (const item of cases) {
  test(`nextSpeaking: ${item.name}`, () => {
    assert.deepEqual(nextSpeaking(item.lastLoudAt, item.level, item.now), { loudAt: item.loudAt, speaking: item.speaking });
  });
}

test("peakLevel: measures deviation from the 128 midpoint", () => {
  assert.equal(peakLevel(new Uint8Array([128, 128])), 0);
  assert.equal(peakLevel(new Uint8Array([128, 192, 64])), 0.5);
});
