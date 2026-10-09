import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

test.use({ hasTouch: true });

test("themed selects support keyboard, touch and viewport fitting inside settings", async ({ page }) => {
  await page.goto(`/room/${encodeURIComponent(process.env.SMOKE_ROOM || "chopper")}`);
  const microphone = page.getByRole("combobox", { name: "Микрофон", exact: true });
  await expect(microphone).toBeEnabled();
  await microphone.click();
  const devices = page.getByRole("listbox", { name: "Микрофон", exact: true });
  await expect(devices).toBeVisible();
  await expect(devices.getByRole("option", { selected: true })).toHaveCount(1);
  await microphone.press("End");
  const active = await microphone.getAttribute("aria-activedescendant");
  await expect(page.locator(`[id="${active}"]`)).toHaveAttribute("data-active", "true");
  const chosen = await page.locator(`[id="${active}"]`).innerText();
  await microphone.press("Enter");
  await expect(microphone).toContainText(chosen);
  await expect(devices).toHaveCount(0);
  await microphone.click();
  await page.getByRole("textbox", { name: "Введите имя" }).click();
  await expect(devices).toHaveCount(0);

  await nextDriver(page).join(`select-${Date.now()}`);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Настройки встречи" });
  const noise = dialog.getByRole("combobox", { name: "Шумоподавление", exact: true });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 640 });
    await noise.click();
    const list = page.getByRole("listbox", { name: "Шумоподавление", exact: true });
    await expect(list).toBeVisible();
    const box = await list.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(7);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 7);
    expect(box.y).toBeGreaterThanOrEqual(7);
    expect(box.y + box.height).toBeLessThanOrEqual((await page.viewportSize()).height - 7);
    await expect(list.getByRole("option", { name: "Усиленное", exact: true })).toBeVisible();
    await noise.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(dialog).toBeVisible();
  }
  await noise.press("Home");
  await noise.press("Enter");
  await expect(noise).toContainText("Выключено");
  await noise.click();
  await page.getByRole("option", { name: "Усиленное", exact: true }).tap();
  await expect(noise).toContainText("Усиленное");
  await dialog.getByRole("button", { name: "Закрыть настройки" }).click();
  await nextDriver(page).leave();
});
