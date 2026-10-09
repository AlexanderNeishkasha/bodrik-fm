import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

test("setting help opens only from its question mark, with keyboard dismissal", async ({ page }) => {
  const driver = nextDriver(page);
  await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
  await driver.join(`help-${Date.now()}`);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Настройки встречи" });
  const help = dialog.getByRole("button", { name: "Справка: Шумоподавление", exact: true });
  const label = dialog.getByText("Шумоподавление", { exact: true });
  await label.hover();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await help.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await tip.hover();
  await expect(tip).toBeVisible();
  await label.hover();
  await expect(tip).toHaveCount(0);
  await help.focus();
  await expect(tip).toBeVisible();
  await help.press("Escape");
  await expect(tip).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть настройки" }).click();
  await driver.leave();
});
