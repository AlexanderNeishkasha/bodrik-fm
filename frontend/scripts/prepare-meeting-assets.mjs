import { build } from "esbuild";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy the meeting's runtime assets into public/meeting-assets (git-ignored):
 * Neural denoiser worklets, WASM and models; MediaPipe selfie segmentation (script, model, WASM),
 * the event sounds that ship
 * with the meeting component, and the development `/brand` document (production serves it
 * from Rust).
 * Nothing is fetched from a CDN at runtime.
 */
const frontendRoot = fileURLToPath(new URL("../", import.meta.url));
const meetingAssets = path.join(frontendRoot, "assets", "meeting");
const destination = path.join(frontendRoot, "public", "meeting-assets");
const modules = path.join(frontendRoot, "node_modules");

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

const rnnoise = path.join(modules, "@sapphi-red", "web-noise-suppressor", "dist");
await mkdir(path.join(destination, "rnnoise"), { recursive: true });
await cp(path.join(rnnoise, "rnnoise", "workletProcessor.js"), path.join(destination, "rnnoise", "workletProcessor.js"));
for (const file of ["rnnoise.wasm", "rnnoise_simd.wasm"]) await cp(path.join(rnnoise, file), path.join(destination, "rnnoise", file));

await build({
  entryPoints: [path.join(frontendRoot, "features", "meeting", "client", "denoisedGainWorklet.mjs")],
  outfile: path.join(destination, "denoisedGain", "workletProcessor.js"),
  bundle: true, format: "esm", platform: "browser", target: "es2022",
});

const deepfilter = path.join(modules, "@workadventure", "noise-suppression");
await cp(path.join(deepfilter, "dist", "assets", "deepfilternet"), path.join(destination, "deepfilternet"), { recursive: true });
await cp(path.join(deepfilter, "dist", "assets", "deepfilternet-worklet-processor.js"), path.join(destination, "deepfilternet", "workletProcessor.js"));
await cp(path.join(deepfilter, "LICENSE"), path.join(destination, "deepfilternet", "LICENSE"));
await cp(path.join(meetingAssets, "denoisers"), path.join(destination, "licenses", "denoisers"), { recursive: true });

const segmentation = path.join(modules, "@mediapipe", "selfie_segmentation");
await mkdir(path.join(destination, "selfie_segmentation"), { recursive: true });
for (const file of await readdir(segmentation)) {
  if (/\.(js|wasm|data|tflite|binarypb)$/.test(file) && file !== "index.d.ts") {
    await cp(path.join(segmentation, file), path.join(destination, "selfie_segmentation", file));
  }
}

await writeFile(path.join(frontendRoot, "public", "brand"), JSON.stringify({ message: { about: {} } }));

// Preserve the license distributed with the meeting assets.
await cp(path.join(meetingAssets, "LICENSE"), path.join(destination, "LICENSE"));

await cp(path.join(meetingAssets, "sounds"), path.join(destination, "sounds"), { recursive: true });
