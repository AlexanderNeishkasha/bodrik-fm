import { NEURAL_NOISE_MODES } from "./noiseModes.mjs";

/** Self-hosted runtime files prepared at build/dev startup. */
const ASSETS = "/meeting-assets";

/** Create one selected, locally served neural worklet, without initializing other models. */
async function createWorklet(context, mode, signal) {
  if (mode === "deepfilternet") {
    const { createDeepFilterNetAudioWorklet } = await import("@workadventure/noise-suppression/deepfilternet");
    return createDeepFilterNetAudioWorklet(context, {
      moduleUrl: `${ASSETS}/deepfilternet/workletProcessor.js`,
      wasmUrl: `${ASSETS}/deepfilternet/df_bg.wasm`,
      modelUrl: `${ASSETS}/deepfilternet/DeepFilterNet3_onnx.tar.gz`,
      bypassUntilReady: false,
    });
  }
  const { RnnoiseWorkletNode, loadRnnoise } = await import("@sapphi-red/web-noise-suppressor");
  const wasmBinary = await loadRnnoise({ url: `${ASSETS}/rnnoise/rnnoise.wasm`, simdUrl: `${ASSETS}/rnnoise/rnnoise_simd.wasm` }, { signal });
  await context.audioWorklet.addModule(`${ASSETS}/rnnoise/workletProcessor.js`);
  const node = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary });
  // The wrapper processes only its first channel. Explicit mono avoids a silent
  // second channel being averaged into the WebRTC microphone at half amplitude.
  node.channelCount = 1;
  node.channelCountMode = "explicit";
  return { node, ready: Promise.resolve(), dispose() { node.disconnect(); node.destroy?.(); } };
}

/**
 * Own one neural microphone graph. The input stays with capture; output, worklet and
 * context belong to the returned handle. Initialization failure releases all resources.
 * Runtime failures notify the capture owner. Close the context to release WASM memory.
 */
export async function processNoise(track, { mode = "rnnoise", autoGainControl = true, onError = () => {}, signal } = {}) {
  if (!NEURAL_NOISE_MODES.includes(mode)) throw new Error(`Unknown neural noise mode: ${mode}`);
  if (signal?.aborted) throw new DOMException("Microphone processing cancelled", "AbortError");
  const context = new AudioContext({ sampleRate: 48000 });
  let worklet, gainNode, source, output;
  let disposed = false;
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  /** Cancel startup immediately, even if a library download is still completing in the background. */
  function abort() {
    dispose();
    rejectAborted(new DOMException("Microphone processing cancelled", "AbortError"));
  }
  /** Report render-thread failures while this handle is still owned by the call. */
  function failed(event) {
    if (!disposed) onError(new Error(`${mode}: ${event?.data?.message || "AudioWorklet processing failed"}`));
  }
  /** Only structured worklet errors are failures; ready/load telemetry is not. */
  function message(event) { if (event.data.type === "error") failed(event); }
  /** Idempotently stop the processed track and release the entire graph, never the raw input. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", abort);
    source?.disconnect();
    output?.stop();
    worklet?.node.port.removeEventListener("message", message);
    worklet?.node.removeEventListener("processorerror", failed);
    worklet?.dispose();
    if (gainNode) {
      gainNode.port.removeEventListener("message", message);
      gainNode.removeEventListener("processorerror", failed);
      gainNode.port.postMessage({ type: "dispose" });
      gainNode.disconnect();
    }
    context.close().catch((error) => console.warn("Noise suppression context cleanup failed", error));
  }
  try {
    signal?.addEventListener("abort", abort, { once: true });
    await Promise.race([context.resume(), aborted]);
    const creation = createWorklet(context, mode, signal).then((created) => {
      if (disposed) {
        created.ready.catch(() => {});
        created.dispose();
      }
      return created;
    });
    worklet = await Promise.race([creation, aborted]);
    await Promise.race([worklet.ready, aborted]);
    if (disposed || track.readyState === "ended") throw new DOMException("Microphone capture cancelled", "AbortError");
    if (autoGainControl) {
      await Promise.race([context.audioWorklet.addModule(`${ASSETS}/denoisedGain/workletProcessor.js`), aborted]);
      if (disposed) throw new DOMException("Microphone processing cancelled", "AbortError");
      gainNode = new AudioWorkletNode(context, "meeting-denoised-gain", {
        channelCount: 1, channelCountMode: "explicit", numberOfInputs: 1,
        numberOfOutputs: 1, outputChannelCount: [1],
      });
      gainNode.port.addEventListener("message", message);
      gainNode.addEventListener("processorerror", failed);
      gainNode.port.start();
    }
    worklet.node.port.addEventListener("message", message);
    worklet.node.addEventListener("processorerror", failed);
    source = context.createMediaStreamSource(new MediaStream([track]));
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    destination.channelCountMode = "explicit";
    const filtered = source.connect(worklet.node);
    if (gainNode) filtered.connect(gainNode).connect(destination);
    else filtered.connect(destination);
    output = destination.stream.getAudioTracks()[0];
    if (!output) throw new Error(`${mode} did not create an audio track`);
    signal?.removeEventListener("abort", abort);
    return { track: output, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
