/** Self-hosted processing assets (scripts/prepare-meeting-assets.mjs). */
const ASSETS = "/meeting-assets";

/** Background blur strengths by mode. */
export const BLUR_PX = Object.freeze({ low: 10, high: 20 });

/** Camera effects: none, light background blur, strong background blur. */
export const BACKGROUND_MODES = Object.freeze(["off", "low", "high"]);

/** Whether the browser can run RNNoise in an AudioWorklet. */
export function noiseSuppressionSupported(scope = globalThis) {
  return typeof scope.AudioWorkletNode === "function" && typeof scope.WebAssembly === "object";
}

/** Whether the browser can run the background pipeline. */
export function backgroundSupported(scope = globalThis) {
  return typeof scope.HTMLCanvasElement?.prototype?.captureStream === "function" && typeof scope.WebAssembly === "object";
}

/**
 * Run a microphone track through RNNoise. Resolves with `{ track, dispose }`; the
 * output track belongs to the returned handle, the input stays with its owner.
 */
export async function processNoise(track) {
  const { RnnoiseWorkletNode, loadRnnoise } = await import("@sapphi-red/web-noise-suppressor");
  const context = new AudioContext({ sampleRate: 48000 });
  try {
    const wasmBinary = await loadRnnoise({ url: `${ASSETS}/rnnoise/rnnoise.wasm`, simdUrl: `${ASSETS}/rnnoise/rnnoise_simd.wasm` });
    await context.audioWorklet.addModule(`${ASSETS}/rnnoise/workletProcessor.js`);
    const node = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary });
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const destination = context.createMediaStreamDestination();
    source.connect(node).connect(destination);
    const output = destination.stream.getAudioTracks()[0];
    return {
      track: output,
      dispose() {
        source.disconnect();
        node.disconnect();
        node.destroy?.();
        output.stop();
        context.close().catch(() => {});
      },
    };
  } catch (error) {
    context.close().catch(() => {});
    throw error;
  }
}

let segmenterScript = null;

/** Load the MediaPipe selfie segmentation script once (it defines a global). */
function loadSegmenterScript() {
  if (globalThis.SelfieSegmentation) return Promise.resolve(globalThis.SelfieSegmentation);
  segmenterScript ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${ASSETS}/selfie_segmentation/selfie_segmentation.js`;
    script.async = true;
    script.onload = () => resolve(globalThis.SelfieSegmentation);
    script.onerror = () => {
      segmenterScript = null;
      script.remove();
      reject(new Error("Could not load background segmentation"));
    };
    document.head.append(script);
  });
  return segmenterScript;
}

/**
 * Run a camera track through person segmentation and blur the background.
 * `mode` is "low" or "high" (BLUR_PX). Resolves with `{ track, dispose }`; the output
 * belongs to the handle, the input to its owner.
 */
export async function processBackground(track, { mode }) {
  const SelfieSegmentation = await loadSegmenterScript();
  const settings = track.getSettings?.() || {};
  const width = settings.width || 1280;
  const height = settings.height || 720;
  const frameRate = Math.min(settings.frameRate || 30, 30);

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await video.play();

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const segmenter = new SelfieSegmentation({ locateFile: (file) => `${ASSETS}/selfie_segmentation/${file}` });
  segmenter.setOptions({ modelSelection: 1 });
  segmenter.onResults(({ image, segmentationMask }) => {
    context.save();
    context.clearRect(0, 0, width, height);
    context.drawImage(segmentationMask, 0, 0, width, height);
    // Keep only the person, then draw the blurred frame behind it.
    context.globalCompositeOperation = "source-in";
    context.drawImage(image, 0, 0, width, height);
    context.globalCompositeOperation = "destination-over";
    context.filter = `blur(${BLUR_PX[mode] || BLUR_PX.low}px)`;
    context.drawImage(image, 0, 0, width, height);
    context.restore();
  });
  await segmenter.initialize();

  let stopped = false;
  let busy = false;
  const timer = setInterval(() => {
    if (stopped || busy || video.readyState < 2) return;
    busy = true;
    segmenter.send({ image: video }).finally(() => {
      busy = false;
    });
  }, 1000 / frameRate);
  const output = canvas.captureStream(frameRate).getVideoTracks()[0];
  return {
    track: output,
    dispose() {
      stopped = true;
      clearInterval(timer);
      output.stop();
      video.srcObject = null;
      Promise.resolve(segmenter.close()).catch(() => {});
    },
  };
}
