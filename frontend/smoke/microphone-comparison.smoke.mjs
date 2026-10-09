import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

test("all microphone meters run only while the quick menu is open", async ({ page }) => {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const enumerate = media.enumerateDevices.bind(media);
    const acquire = media.getUserMedia.bind(media);
    window.comparisonStreams = [];
    window.callStreams = [];
    /** Two aliases for browser fake capture exercise independent per-device probes. */
    media.enumerateDevices = async () => [...(await enumerate()).filter((device) => device.kind !== "audioinput"),
      { kind: "audioinput", deviceId: "virtual-one", label: "Microphone one" },
      { kind: "audioinput", deviceId: "virtual-two", label: "Microphone two" }];
    media.getUserMedia = async (constraints) => {
      const comparison = constraints.audio?.echoCancellation === false && constraints.audio?.noiseSuppression === false && constraints.audio?.autoGainControl === false;
      const id = constraints.audio?.deviceId?.exact;
      if (id?.startsWith("virtual-")) {
        constraints = { ...constraints, audio: { ...constraints.audio } };
        delete constraints.audio.deviceId;
      }
      const stream = await acquire(constraints);
      if (comparison) { stream.comparisonSample = id === "virtual-one" ? 160 : 144; window.comparisonStreams.push(stream); }
      else if (constraints.audio) window.callStreams.push(stream);
      return stream;
    };
    const createSource = AudioContext.prototype.createMediaStreamSource;
    /** Keep the real graph but give comparison analysers distinct deterministic levels. */
    AudioContext.prototype.createMediaStreamSource = function (stream) {
      const source = createSource.call(this, stream);
      const connect = source.connect.bind(source);
      source.connect = (node) => { if (stream.comparisonSample) node.comparisonSample = stream.comparisonSample; return connect(node); };
      return source;
    };
    const read = AnalyserNode.prototype.getByteTimeDomainData;
    AnalyserNode.prototype.getByteTimeDomainData = function (data) {
      if (this.comparisonSample) data.fill(this.comparisonSample);
      else read.call(this, data);
    };
  });
  const driver = nextDriver(page);
  await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
  await driver.join(`comparison-${Date.now()}`);
  expect(await page.evaluate(() => window.comparisonStreams.length)).toBe(0);
  const toggle = page.getByRole("button", { name: "Выбор микрофона и динамика", exact: true });
  await toggle.click();
  const menu = page.getByRole("menu", { name: "Микрофоны", exact: true });
  await expect(menu.getByRole("meter")).toHaveCount(2);
  await expect(menu.getByRole("meter", { name: "Уровень микрофона: Microphone one", exact: true })).toHaveAttribute("aria-valuenow", "0.375");
  await expect(menu.getByRole("meter", { name: "Уровень микрофона: Microphone two", exact: true })).toHaveAttribute("aria-valuenow", "0.1875");
  const opened = await page.evaluate(() => window.comparisonStreams.length);
  await menu.getByRole("menuitemradio", { name: /Microphone two/ }).click();
  await expect(menu.getByRole("menuitemradio", { name: /Microphone two/ })).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => window.comparisonStreams.length)).toBe(opened);
  expect(await page.evaluate(() => window.comparisonStreams.filter((stream) => stream.getAudioTracks()[0].readyState === "live").length)).toBe(2);
  await toggle.click();
  await expect.poll(() => page.evaluate(() => window.comparisonStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")))).toBe(true);
  expect(await page.evaluate(() => window.callStreams.at(-1).getAudioTracks()[0].readyState)).toBe("live");
  await toggle.click();
  await expect.poll(() => page.evaluate(() => window.comparisonStreams.filter((stream) => stream.getAudioTracks()[0].readyState === "live").length)).toBe(2);
  await expect(menu.getByRole("meter", { name: "Уровень микрофона: Microphone one", exact: true })).toHaveAttribute("aria-valuenow", "0.375");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toBeHidden();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.comparisonStreams.every(stream => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
  expect(await page.evaluate(() => window.callStreams.at(-1).getAudioTracks()[0].readyState)).toBe("live");
  const controls = page.getByRole("navigation", { name: "Управление встречей" });
  for (const trigger of await controls.locator("button[aria-haspopup=menu]").all()) await expect(trigger).toBeHidden();
  for (const width of [320, 380, 390, 700]) {
    await page.setViewportSize({ width, height: 844 });
    for (const button of await controls.locator("button:visible").all()) {
      const box = await button.boundingBox();
      expect(box.width, `round control at ${width}px`).toBe(box.height);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
  }
  await controls.getByRole("button", { name: "Настройки", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Настройки встречи", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(toggle).toBeVisible();
  await expect(menu).toHaveCount(0);
  await driver.leave();
});
