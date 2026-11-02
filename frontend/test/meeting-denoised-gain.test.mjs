import assert from "node:assert/strict";
import test from "node:test";
import { DENOISED_GAIN, DenoisedGain } from "../features/meeting/client/denoisedGain.mjs";

for (const [name, amplitude, expectedDb] of [
  ["quiet voice restored toward target", 0.02, DENOISED_GAIN.targetDb - 20 * Math.log10(0.02)],
  ["weak active input respects maximum boost", 0.008, DENOISED_GAIN.maxDb],
  ["loud voice respects attenuation bound", 0.5, DENOISED_GAIN.minDb],
  ["silence never learns a boost", 0, 0],
  ["low residual noise never learns a boost", 0.001, 0],
]) {
  test(`denoised gain policy: ${name}`, () => {
    const gain = new DenoisedGain(48000);
    const input = new Float32Array(128).fill(amplitude);
    const output = new Float32Array(128);
    for (let index = 0; index < 1500; index++) gain.process(input, output);
    assert.ok(Math.abs(gain.gainDb - expectedDb) < 0.001);
    assert.ok(output.every(Number.isFinite));
    assert.ok(output.every(value => Math.abs(value) <= DENOISED_GAIN.ceiling + 1e-7));
    if (amplitude === 0.02) assert.ok(Math.abs(output[127] - 10 ** (DENOISED_GAIN.targetDb / 20)) < 1e-6);
    if (expectedDb === 0) assert.deepEqual(output, input);
  });
}

test("gain adaptation is time-based, not dependent on render quantum length", () => {
  for (const size of [128, 256, 480]) {
    const gain = new DenoisedGain(48000);
    for (let count = 0; count < 48000 / size; count++) gain.process(new Float32Array(size).fill(0.02), new Float32Array(size));
    assert.ok(Math.abs(gain.gainDb - 8) < 0.03);
  }
});

test("peak protection handles a loud onset immediately, even after quiet voice was boosted", () => {
  const gain = new DenoisedGain(48000);
  const quiet = new Float32Array(128).fill(0.02);
  const output = new Float32Array(128);
  for (let count = 0; count < 1500; count++) gain.process(quiet, output);
  const transient = new Float32Array(128).fill(0.02);
  transient[31] = 2; transient[93] = -2;
  gain.process(transient, output);
  assert.ok(output.every(value => Math.abs(value) <= DENOISED_GAIN.ceiling + 1e-7));
  assert.ok(output[31] > 0 && output[93] < 0);
});

test("silence and absent input remain silent after gain has increased", () => {
  const gain = new DenoisedGain(48000);
  const output = new Float32Array(128);
  for (let count = 0; count < 1500; count++) gain.process(new Float32Array(128).fill(0.02), output);
  const previous = gain.gainDb;
  gain.process(undefined, output);
  assert.ok(output.every(value => value === 0));
  assert.equal(gain.gainDb, previous);
});

for (const value of [NaN, Infinity, -Infinity]) {
  test(`non-finite denoised sample reports failure: ${value}`, () => {
    const gain = new DenoisedGain(48000);
    assert.throws(() => gain.process(new Float32Array([value]), new Float32Array(1)), /non-finite/);
  });
}
