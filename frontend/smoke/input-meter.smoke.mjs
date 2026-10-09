import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

test("microphone meters follow an input switch and animate with reduced-motion support", async ({ page }) => {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const enumerate = media.enumerateDevices.bind(media);
    const acquire = media.getUserMedia.bind(media);
    /** Add a virtual alias for the fake microphone, preserving actual browser track creation. */
    media.enumerateDevices = async () => [...await enumerate(), { kind: "audioinput", deviceId: "virtual-test", groupId: "test", label: "Virtual test microphone" }];
    media.getUserMedia = (constraints) => {
      if (constraints.audio?.deviceId?.exact === "virtual-test") {
        constraints = { ...constraints, audio: { ...constraints.audio } };
        delete constraints.audio.deviceId;
      }
      return acquire(constraints);
    };
    window.meterTracks = [];
    const createSource = AudioContext.prototype.createMediaStreamSource;
    /** Observe each graph's real track and provide deterministic meter samples. */
    AudioContext.prototype.createMediaStreamSource = function (stream) {
      window.meterTracks.push(stream.getAudioTracks()[0]);
      return createSource.call(this, stream);
    };
    AnalyserNode.prototype.getByteTimeDomainData = function (data) { data.fill(160); };
  });
  const driver = nextDriver(page);
  await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
  await driver.join(`meter-${Date.now()}`);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Настройки встречи" });
  const meter = dialog.getByRole("meter", { name: "Уровень микрофона" });
  await expect(meter).toHaveAttribute("aria-valuenow", "0.375");
  await page.evaluate(() => { window.beforeSwitchTrack = window.meterTracks.at(-1); });
  await dialog.getByRole("combobox", { name: "Микрофон", exact: true }).click();
  await page.getByRole("option", { name: "Virtual test microphone", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.meterTracks.at(-1) !== window.beforeSwitchTrack)).toBe(true);
  await expect(meter).toHaveAttribute("aria-valuenow", "0.375");
  expect(await meter.locator("span").first().evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0.14s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await meter.locator("span").first().evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s");
  await dialog.getByRole("button", { name: "Закрыть настройки" }).click();
  await page.getByRole("button", { name: "Выбор микрофона и динамика", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Микрофоны", exact: true }).getByRole("meter").first()).toHaveAttribute("aria-valuenow", "0.375");
  await page.getByRole("button", { name: "Выбор микрофона и динамика", exact: true }).click();
  await driver.leave();
});
