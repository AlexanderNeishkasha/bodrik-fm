import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

test("recording is absent from settings, tools and keyboard shortcuts", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.encoderRequests = 0;
    const NativeRecorder = window.MediaRecorder;
    /** Detect any encoder allocation, including hidden keyboard actions. */
    window.MediaRecorder = class extends NativeRecorder {
      constructor(...args) {
        super(...args);
        window.encoderRequests++;
      }
    };
  });
  const page = await context.newPage();
  const driver = nextDriver(page);
  try {
    await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
    await driver.join(`NoRecorder${Date.now().toString(36).slice(-4)}`);
    const controls = page.getByRole("navigation", { name: "Управление встречей" });
    await controls.getByRole("button", { name: "Дополнительно", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /запись/i })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Файлы", exact: true })).toHaveCount(0);
    await controls.getByRole("button", { name: "Дополнительно", exact: true }).click();
    await page.keyboard.press("r");
    await controls.getByRole("button", { name: "Настройки", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Запись", exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Горячие клавиши", exact: true }).click();
    const shortcuts = page.getByRole("tabpanel", { name: "Горячие клавиши", exact: true });
    await expect(shortcuts.locator("kbd", { hasText: /^R$/ })).toHaveCount(0);
    await expect(shortcuts.locator("kbd", { hasText: /^F$/ })).toHaveCount(0);
    expect(await page.evaluate(() => window.encoderRequests)).toBe(0);
    await page.getByRole("button", { name: "Закрыть настройки" }).click();
    await driver.leave();
  } finally {
    await context.close();
  }
});
