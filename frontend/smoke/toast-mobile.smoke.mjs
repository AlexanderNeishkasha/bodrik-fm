import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

const message = "The request is not allowed by the user agent or the platform in the current context.";

test("long meeting errors stay rectangular and readable on mobile", async ({ page }) => {
  await page.addInitScript((text) => {
    /** Exercise the normal failed-action notification path without opening a capture chooser. */
    navigator.mediaDevices.getDisplayMedia = async () => { throw new Error(text); };
  }, message);
  const driver = nextDriver(page);
  await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
  await driver.join(`toast-${Date.now()}`);
  const controls = page.getByRole("navigation", { name: "Управление встречей" });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await controls.getByRole("button", { name: "Демонстрация экрана", exact: true }).click();
    const toast = page.getByRole("alert").filter({ hasText: message });
    await expect(toast).toBeVisible();
    const box = await toast.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(width - 34);
    expect(box.x).toBeGreaterThanOrEqual(15);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 15);
    expect(await toast.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)).toBe("16px");
    expect(await toast.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await driver.leave();
});
