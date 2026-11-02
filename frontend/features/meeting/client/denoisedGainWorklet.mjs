import { DenoisedGain } from "./denoisedGain.mjs";

/** Mono output leveller, placed after the selected denoiser instead of before it. */
class DenoisedGainWorklet extends AudioWorkletProcessor {
  /** Own one gain envelope for the microphone and an explicit disposal message. */
  constructor() {
    super();
    this.gain = new DenoisedGain(sampleRate);
    this.disposed = false;
    this.port.onmessage = (event) => { if (event.data.type === "dispose") this.disposed = true; };
  }

  /** Level the denoised input without extra frame buffering; report invalid audio and stop. */
  process(inputs, outputs) {
    if (this.disposed) return false;
    const output = outputs[0]?.[0];
    if (!output) return true;
    try {
      this.gain.process(inputs[0]?.[0], output);
      return true;
    } catch (error) {
      output.fill(0);
      this.port.postMessage({ type: "error", message: error.message });
      this.disposed = true;
      return false;
    }
  }
}

registerProcessor("meeting-denoised-gain", DenoisedGainWorklet);
