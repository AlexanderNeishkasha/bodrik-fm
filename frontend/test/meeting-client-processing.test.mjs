import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKGROUND_MODES, BLUR_PX, backgroundSupported, noiseSuppressionSupported } from "../features/meeting/client/processing.mjs";

test("camera effects are none, light and strong blur", () => {
  assert.deepEqual(BLUR_PX, { low: 10, high: 20 });
  assert.deepEqual(BACKGROUND_MODES, ["off", "low", "high"]);
});

test("feature detection requires the browser primitives", () => {
  const cases = [
    ["no browser", {}, false, false],
    ["worklet and wasm", { AudioWorkletNode: function AudioWorkletNode() {}, WebAssembly: {} }, true, false],
    ["canvas capture and wasm", { HTMLCanvasElement: { prototype: { captureStream() {} } }, WebAssembly: {} }, false, true],
  ];
  for (const [name, scope, noise, background] of cases) {
    assert.equal(noiseSuppressionSupported(scope), noise, name);
    assert.equal(backgroundSupported(scope), background, name);
  }
});
