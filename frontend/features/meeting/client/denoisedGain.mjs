/** Output level policy shared by every neural denoiser, not by the browser's basic mode. */
export const DENOISED_GAIN = Object.freeze({ targetDb: -23, activityDb: -45, maxDb: 15, minDb: -10, riseDbPerSecond: 8, fallDbPerSecond: 24, ceiling: 0.9 });

/** Smooth bounded gain on denoised audio; never adapts upward from silence/background below the activity floor. */
export class DenoisedGain {
  /** Start at unity, avoiding a sudden boost when a model first becomes ready. */
  constructor(rate) {
    this.rate = rate;
    this.gainDb = 0;
  }

  /** Level one render quantum into a caller-owned output buffer, limiting peaks without clipping. */
  process(input, output) {
    let energy = 0, peak = 0;
    for (let index = 0; index < output.length; index++) {
      const value = input?.[index] ?? 0;
      if (!Number.isFinite(value)) throw new Error("Denoised audio contains a non-finite sample");
      energy += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const levelDb = 10 * Math.log10(energy / Math.max(1, output.length) + 1e-12);
    const previousDb = this.gainDb;
    if (levelDb > DENOISED_GAIN.activityDb) {
      const wantedDb = Math.max(DENOISED_GAIN.minDb, Math.min(DENOISED_GAIN.maxDb, DENOISED_GAIN.targetDb - levelDb));
      const seconds = output.length / this.rate;
      const delta = Math.max(-DENOISED_GAIN.fallDbPerSecond * seconds, Math.min(DENOISED_GAIN.riseDbPerSecond * seconds, wantedDb - previousDb));
      this.gainDb += delta;
    }
    const limit = peak ? DENOISED_GAIN.ceiling / peak : Infinity;
    const start = Math.min(10 ** (previousDb / 20), limit);
    const end = Math.min(10 ** (this.gainDb / 20), limit);
    for (let index = 0; index < output.length; index++) {
      const gain = start + (end - start) * (index + 1) / output.length;
      output[index] = (input?.[index] ?? 0) * gain;
    }
  }
}
