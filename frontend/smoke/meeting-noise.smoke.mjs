import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Bundle the actual graph owner; model/WASM URLs still point at locally prepared meeting assets. */
const probe = await build({
  entryPoints: [fileURLToPath(new URL("../features/meeting/client/noiseProcessing.mjs", import.meta.url))],
  bundle: true, format: "esm", platform: "browser", target: "es2022", write: false,
});

/** Isolate audio verification from admission, accounts and any real meeting or microphone. */
async function openProbe(page) {
  await page.route("**/__noise-probe__", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local noise graph probe</title><body>Local noise graph probe</body>" }));
  await page.route("**/__noise-probe__.js", route => route.fulfill({ contentType: "text/javascript", body: probe.outputFiles[0].text }));
  await page.goto("/__noise-probe__");
}

test("real neural worklets run repeatedly and release only their owned tracks", async ({ page }, testInfo) => {
  await openProbe(page);
  const results = await page.evaluate(async () => {
    const { processNoise } = await import("/__noise-probe__.js");
    const context = new AudioContext({ sampleRate: 48000 });
    await context.resume();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    const raw = destination.stream.getAudioTracks()[0];
    const results = [];
    try {
      for (const mode of ["rnnoise", "deepfilternet", "rnnoise", "deepfilternet"]) {
        const errors = [];
        const handle = await processNoise(raw, { mode, onError: error => errors.push(error.message) });
        const analyser = context.createAnalyser();
        const source = context.createMediaStreamSource(new MediaStream([handle.track]));
        source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let peak = 0, finite = true;
        try {
          await new Promise(resolve => {
            const end = performance.now() + 300;
            /** Collect rendered samples for a moment, not merely a live-track flag. */
            function sample() {
              analyser.getFloatTimeDomainData(samples);
              for (const value of samples) { finite &&= Number.isFinite(value); peak = Math.max(peak, Math.abs(value)); }
              if (performance.now() < end) requestAnimationFrame(sample);
              else resolve();
            }
            sample();
          });
        } finally {
          source.disconnect(); handle.dispose(); handle.dispose();
        }
        results.push({ mode, errors, peak, finite, channels: handle.track.getSettings().channelCount,
          input: raw.readyState, output: handle.track.readyState });
      }
    } finally {
      oscillator.stop(); raw.stop(); await context.close();
    }
    return results;
  });
  await testInfo.attach("noise-graphs", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  expect(results).toHaveLength(4);
  for (const result of results) {
    expect(result.errors, result.mode).toEqual([]);
    expect(result.finite, result.mode).toBe(true);
    expect(result.channels, result.mode).toBe(1);
    expect(result.peak, result.mode).toBeGreaterThan(0);
    expect(result.input, result.mode).toBe("live");
    expect(result.output, result.mode).toBe("ended");
  }
});

test("failed model download rejects initialization and closes its context", async ({ page }) => {
  await openProbe(page);
  await page.route("**/meeting-assets/deepfilternet/df_bg.wasm", route => route.fulfill({ status: 503, body: "test failure" }));
  const result = await page.evaluate(async () => {
    const { processNoise } = await import("/__noise-probe__.js");
    const Original = AudioContext;
    const contexts = [];
    /** Track genuine browser contexts so a live-looking fake cannot conceal a leak. */
    globalThis.AudioContext = class extends Original {
      /** Preserve native audio behavior and record ownership. */
      constructor(options) { super(options); contexts.push(this); }
    };
    const input = new Original({ sampleRate: 48000 });
    const destination = input.createMediaStreamDestination();
    const raw = destination.stream.getAudioTracks()[0];
    let error = "";
    try { await processNoise(raw, { mode: "deepfilternet" }); }
    catch (caught) { error = caught.message; }
    finally { raw.stop(); await input.close(); globalThis.AudioContext = Original; }
    return { error, states: contexts.map(context => context.state) };
  });
  expect(result.error).toContain("503");
  expect(result.states).toEqual(["closed"]);
});
