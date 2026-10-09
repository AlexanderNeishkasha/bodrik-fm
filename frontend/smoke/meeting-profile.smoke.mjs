import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

for (const width of [1280, 390]) {
  test(`compact meeting profile retains name editing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const driver = nextDriver(page);
    const name = `Profile${Date.now().toString(36).slice(-6)}`;
    await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
    await driver.join(name);
    try {
      await page.getByRole("navigation", { name: "Управление встречей" }).getByRole("button", { name: "Настройки", exact: true }).click();
      await page.getByRole("tab", { name: "Профиль", exact: true }).click();
      const profile = page.getByRole("heading", { name: "Ваш профиль" }).locator("xpath=ancestor::section[1]");
      await expect(profile.getByText(name, { exact: true })).toBeVisible();
      await expect(profile.getByText(/^(Ведущий|Участник)$/)).toBeVisible();
      await expect(profile.getByText("Да", { exact: true })).toHaveCount(0);
      const avatar = profile.getByRole("img", { name, exact: true });
      expect((await avatar.boundingBox()).width).toBeLessThanOrEqual(80);
      const renamed = `${name}New`;
      await profile.getByRole("textbox", { name: "Имя пользователя" }).fill(renamed);
      await profile.getByRole("button", { name: "Сохранить", exact: true }).click();
      await expect(profile.getByText(renamed, { exact: true })).toBeVisible();
      await expect(profile.getByRole("img", { name: renamed, exact: true })).toBeVisible();
      await profile.getByLabel("Изменить аватар").setInputFiles("public/android-chrome-192x192.png");
      await expect.poll(() => page.evaluate(() => localStorage.getItem("meeting.avatar"))).toMatch(/^\/uploads\/avatars\/[0-9a-f-]+\.(png|jpg|webp)$/);
      const remembered = await page.evaluate(() => localStorage.getItem("meeting.avatar"));
      // Older settings saved a full URL; both old values and new paths must survive refresh.
      if (width === 390) await page.evaluate(path => localStorage.setItem("meeting.avatar", new URL(path, location.origin).href), remembered);
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Введите имя" })).toBeVisible();
      expect(await page.locator('form span[class*="avatar"][aria-hidden="true"]').getAttribute("style")).toContain(remembered);
      await driver.join(renamed);
      await page.getByRole("navigation", { name: "Управление встречей" }).getByRole("button", { name: "Настройки", exact: true }).click();
      await page.getByRole("tab", { name: "Профиль", exact: true }).click();
      await expect(profile.locator("svg image")).toHaveAttribute("href", remembered);
      const removeAvatar = profile.getByRole("button", { name: "Удалить аватар", exact: true });
      await expect(removeAvatar).toBeVisible();
      await removeAvatar.click();
      await expect(removeAvatar).toHaveCount(0);
      await expect(profile.locator("svg image")).toHaveCount(0);
      await expect(profile.locator("svg text")).toHaveText(renamed.slice(0, 2).toUpperCase());
      expect(await page.evaluate(() => localStorage.getItem("meeting.avatar"))).toBeNull();
      await expect(profile.locator("details")).not.toHaveAttribute("open", "");
      expect(await profile.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.keyboard.press("Escape");
    } finally {
      await page.bringToFront();
      await page.keyboard.press("Escape");
      await driver.leave();
    }
  });
}
