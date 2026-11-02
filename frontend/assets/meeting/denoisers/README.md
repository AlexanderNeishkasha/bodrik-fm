# Microphone denoisers

RNNoise and DeepFilterNet3 run locally in a 48 kHz mono Web Audio graph.
They are alternatives, never stacked with browser noise suppression. Echo
cancellation and automatic gain control keep their independent settings. With
neural modes, automatic gain control runs **after** the filter (browser input AGC
is disabled), so removed noise cannot determine the voice level. It targets
−23 dBFS RMS on active output above −45 dBFS, limits gain to −10…+15 dB,
freezes adaptation below that floor and protects peaks at 0.9. Low residual noise
alone never increases the gain; residual noise can still receive the bounded gain
learned during preceding speech. Turning gain control off bypasses this stage.
The graph is explicitly mono, avoiding a silent second RNNoise output channel
being averaged into the published microphone.
Browser suppression remains the default; saved RNNoise choices retain their meaning.
The removed GTCRN preference is invalid and falls back to the browser default.

- Smart / Умное: RNNoise, existing `@sapphi-red/web-noise-suppressor` integration.
- Studio / Студийное: DeepFilterNet3, `@workadventure/noise-suppression` 0.2.0, MIT wrapper;
  upstream DeepFilterNet code is MIT OR Apache-2.0 (notices in this directory).
  Its default pause gate adds latency: the wrapper reports about 71 ms for
  the complete chain and about 11 MB of assets.

**DeepFilterNet3 weights are experimental for local evaluation.** Upstream's
license declaration explicitly covers code; a separate grant for pretrained
weights remains unresolved in [issue 697](https://github.com/Rikorose/DeepFilterNet/issues/697).
Do not treat these code notices as confirmation of the checkpoint's license;
resolve model redistribution rights before production publication.

`frontend/scripts/prepare-meeting-assets.mjs` copies only the selected engines'
required runtime assets into generated `public/meeting-assets/`. It does not copy
DTLN, Silero, ONNX Runtime Web or LiteRT assets from the WorkAdventure package.
All runtime URLs are same-origin; no CDN or third-party audio upload is used.
Models load only when a neural mode is selected for a published microphone.

Switch algorithms through the microphone quick menu or the full Audio settings.
Use the same microphone, echo cancellation and gain settings when comparing.
Test clean/quiet speech, word beginnings, typing during speech, steady fan noise,
and competing speech; check CPU, dropouts and delay on mobile devices too.
A microphone preview alone is raw and is not a comparison of the denoisers.
Initialization failure retains the existing raw-audio fallback and reports a
processing error; a selected mode is not proof that initialization succeeded.
