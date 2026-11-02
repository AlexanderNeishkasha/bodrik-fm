import assert from "node:assert/strict";
import { test } from "node:test";

import { audioOutputSelectionAvailable, audioRoutingCapabilities, isMobileDevice, screenSharingAvailable } from "../features/meeting/client/capabilities.mjs";
import { createCapture } from "../features/meeting/client/capture.mjs";

test("output routing requires an API and actual destination devices", () => {
  const supported = { prototype: { setSinkId() {} } };
  for (const [name, devices, MediaElement, available] of [
    ["supported output", [{ value: "default" }], supported, true],
    ["no destinations", [], supported, false],
    ["no API", [{ value: "default" }], { prototype: {} }, false],
    ["no media element", [{ value: "default" }], null, false],
  ]) {
    assert.equal(audioOutputSelectionAvailable(devices, MediaElement), available, name);
  }
});

/** Platform and sink capabilities select labels without guessing from device names. */
const routingCases = [
  ["Android Chrome UA", { userAgent: "Linux; Android 16 Chrome/140" }, ["default"], true, false],
  ["Android Vivaldi hints", { userAgentData: { platform: "Android", brands: [{ brand: "Chromium" }] } }, ["default"], true, false],
  ["Android without outputs", { userAgent: "Android Chrome/140" }, [], true, false],
  ["Android independent outputs", { userAgent: "Android Chrome/140" }, ["default", "headphones"], false, true],
  ["Android Firefox", { userAgent: "Android Firefox/140" }, ["default"], false, true],
  ["desktop default output", { userAgent: "Windows Chrome/140" }, ["default"], false, true],
  ["desktop no outputs", { userAgent: "Windows Chrome/140" }, [], false, false],
  ["iPhone without outputs", { userAgent: "iPhone CriOS/140" }, [], false, false],
  ["unknown platform", {}, [], false, false],
  ["platform hint takes precedence", { userAgentData: { platform: "Windows" }, userAgent: "Android Chrome/140" }, ["default"], false, true],
];
for (const [name, navigatorRef, ids, coupledAudioRouting, outputSelectionAvailable] of routingCases) {
  test(`audio routing mode: ${name}`, () => {
    const devices = ids.map((value) => ({ value }));
    assert.deepEqual(audioRoutingCapabilities(devices, navigatorRef, { prototype: { setSinkId() {} } }),
      { coupledAudioRouting, outputSelectionAvailable });
  });
}

test("capture publishes the coupled mode used by prejoin without opening devices", async () => {
  let captures = 0;
  const capture = createCapture({ storage: null, navigatorRef: { userAgent: "Android Chrome/140" }, mediaDevices: {
    async enumerateDevices() { return [{ kind: "audioinput", deviceId: "speakerphone", label: "Speakerphone" }, { kind: "audiooutput", deviceId: "default", label: "Default" }]; },
    getUserMedia() { captures++; throw new Error("Unexpected probe"); },
  } });
  await capture.refreshDevices();
  assert.equal(capture.getSnapshot().coupledAudioRouting, true);
  assert.equal(capture.getSnapshot().outputSelectionAvailable, false);
  assert.equal(capture.getSnapshot().inputDevices[0].value, "speakerphone");
  assert.equal(captures, 0);
});

/** Desktop and mobile capability boundaries, independent of viewport width. */
const cases = [
  ["Android Chromium", { userAgent: "Mozilla/5.0 (Linux; Android 16) Chrome/140" }, true],
  ["Chromium mobile hint", { userAgentData: { mobile: true } }, true],
  ["Android tablet with desktop hint", { userAgentData: { mobile: false }, userAgent: "Android" }, true],
  ["iPhone", { userAgent: "iPhone" }, true],
  ["iPad desktop agent", { platform: "MacIntel", maxTouchPoints: 5 }, true],
  ["Mac desktop", { platform: "MacIntel", maxTouchPoints: 0 }, false],
  ["touchscreen Windows", { platform: "Win32", maxTouchPoints: 10 }, false],
  ["desktop without navigator hints", {}, false],
];

for (const [name, navigatorRef, mobile] of cases) {
  test(`screen sharing capability: ${name}`, async () => {
    let requested = false;
    const mediaDevices = { getDisplayMedia() { requested = true; throw new Error("unexpected capture"); } };
    assert.equal(isMobileDevice(navigatorRef), mobile);
    assert.equal(screenSharingAvailable(mediaDevices, navigatorRef), !mobile);
    assert.equal(screenSharingAvailable({}, navigatorRef), false);
    const capture = createCapture({ mediaDevices, storage: null, navigatorRef });
    assert.equal(capture.getSnapshot().screenAvailable, !mobile);
    if (mobile) {
      await assert.rejects(capture.acquire("screen"), { name: "NotSupportedError" });
      assert.equal(requested, false, "mobile commands cannot invoke the browser capture stub");
    }
  });
}
