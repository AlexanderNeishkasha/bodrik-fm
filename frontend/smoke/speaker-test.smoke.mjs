import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

test("speaker test plays the original melody and releases playback on stop and leave", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.speakerTests = [];
    /** Observe real HTML audio playback without replacing the browser decoder. */
    window.Audio = class extends NativeAudio {
      constructor(url) {
        super(url);
        if (url.endsWith("/speaker.wav")) window.speakerTests.push(this);
      }
    };
  });
  const driver = nextDriver(page);
  await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
  await driver.join(`melody-${Date.now()}`);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Настройки встречи" });
  const testSpeaker = dialog.getByRole("button", { name: "Проверить", exact: true });
  await dialog.getByRole("combobox", { name: "Микрофон", exact: true }).evaluate((node) => {
    window.testDisabledChanges = 0;
    new MutationObserver((records) => { window.testDisabledChanges += records.length; }).observe(node, { attributes: true, attributeFilter: ["disabled"] });
  });
  await testSpeaker.click();
  expect(await page.evaluate(() => window.testDisabledChanges)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.speakerTests[0]?.duration)).toBeCloseTo(4.18, 1);
  await expect.poll(() => page.evaluate(() => window.speakerTests[0]?.paused)).toBe(false);
  const stop = dialog.getByRole("button", { name: "Остановить", exact: true });
  await expect(stop).toBeEnabled();
  await expect(dialog.getByRole("combobox", { name: "Микрофон", exact: true })).toBeEnabled();
  const volume = dialog.getByRole("slider", { name: "Громкость динамика", exact: true });
  await volume.fill("40");
  await expect.poll(() => page.evaluate(() => window.speakerTests[0].volume)).toBeCloseTo(0.2, 3);
  await stop.click();
  await expect(testSpeaker).toBeVisible();
  expect(await page.evaluate(() => window.speakerTests[0].getAttribute("src"))).toBeNull();
  await testSpeaker.click();
  await expect.poll(() => page.evaluate(() => window.speakerTests.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.speakerTests[1]?.paused)).toBe(false);
  await dialog.getByRole("button", { name: "Закрыть настройки" }).click();
  await driver.leave();
  await expect.poll(() => page.evaluate(() => window.speakerTests[1].getAttribute("src"))).toBeNull();
  expect(await page.evaluate(() => window.speakerTests[1].paused)).toBe(true);
});
