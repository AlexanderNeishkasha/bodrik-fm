/** Neural denoisers offered alongside the browser's native suppression. */
export const NEURAL_NOISE_MODES = Object.freeze(["rnnoise", "deepfilternet"]);

/** Valid persisted microphone suppression values; existing RNNoise preferences remain valid. */
export const NOISE_MODES = Object.freeze(["off", "browser", ...NEURAL_NOISE_MODES]);

/** Build the same labelled choices for the audio settings and quick microphone menu. */
export function noiseModeOptions(text, enhancedAvailable) {
  return [
    { value: "off", label: text.off },
    { value: "browser", label: text.browser },
    ...(enhancedAvailable ? [
      { value: "rnnoise", label: text.enhanced },
      { value: "deepfilternet", label: text.maximum },
    ] : []),
  ];
}
