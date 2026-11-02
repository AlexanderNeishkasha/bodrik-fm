import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";
import { smokeRoom } from "./smokeRooms.mjs";

/** The first (most recently used) saved prejoin profile. */
const savedProfile = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("meeting.profiles") || "[]")[0] ?? null);

for (const width of [1280, 390]) {
  test(`compact meeting profile retains name editing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const driver = nextDriver(page);
    const name = `Profile${Date.now().toString(36).slice(-6)}`;
    await page.goto(driver.path(smokeRoom()));
    await driver.join(name);
    try {
      await page.getByRole("navigation", { name: "Управление встречей" }).getByRole("button", { name: "Настройки", exact: true }).click();
      await page.getByRole("tab", { name: "Профиль", exact: true }).click();
      const profile = page.getByRole("heading", { name: "Профиль", exact: true }).locator("xpath=ancestor::section[1]");
      await expect(profile.getByText(name, { exact: true })).toBeVisible();
      await expect(profile.getByText(/^(Ведущий|Участник)$/)).toBeVisible();
      await expect(profile.getByText("Да", { exact: true })).toHaveCount(0);
      const avatar = profile.getByRole("img", { name, exact: true });
      expect((await avatar.boundingBox()).width).toBeLessThanOrEqual(80);
      const renamed = `${name}New`;
      await profile.getByRole("textbox", { name: "Имя", exact: true }).fill(renamed);
      await profile.getByRole("button", { name: "Сохранить", exact: true }).click();
      await expect(profile.getByText(renamed, { exact: true })).toBeVisible();
      await expect(profile.getByRole("img", { name: renamed, exact: true })).toBeVisible();
      await profile.getByLabel("Сменить аватар").setInputFiles("public/android-chrome-192x192.png");
      // The in-meeting rename and avatar update the saved profile instead of adding one.
      await expect.poll(async () => (await savedProfile(page))?.avatar ?? "").toMatch(/^\/uploads\/avatars\/[0-9a-f-]+\.(png|jpg|webp)$/);
      const remembered = (await savedProfile(page)).avatar;
      expect(await savedProfile(page)).toEqual({ name: renamed, avatar: remembered });
      // Older builds kept one identity with a full avatar URL; it must migrate into a profile.
      if (width === 390) await page.evaluate(([savedName, path]) => {
        localStorage.removeItem("meeting.profiles");
        localStorage.setItem("meeting.name", savedName);
        localStorage.setItem("meeting.avatar", new URL(path, location.origin).href);
      }, [renamed, remembered]);
      await page.reload();
      const tile = page.getByRole("button", { name: renamed, exact: true });
      await expect(tile).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("textbox", { name: "Введите имя" })).toHaveCount(0);
      expect(await tile.locator('span[aria-hidden="true"]').first().getAttribute("style")).toContain(remembered);
      await page.getByRole("button", { name: "Присоединиться к встрече" }).click();
      await page.locator("main[data-meeting-status=admitted]").waitFor();
      await page.getByRole("navigation", { name: "Управление встречей" }).getByRole("button", { name: "Настройки", exact: true }).click();
      await page.getByRole("tab", { name: "Профиль", exact: true }).click();
      await expect(profile.locator("svg image")).toHaveAttribute("href", remembered);
      const removeAvatar = profile.getByRole("button", { name: "Удалить аватар", exact: true });
      await expect(removeAvatar).toBeVisible();
      await removeAvatar.click();
      await expect(removeAvatar).toHaveCount(0);
      await expect(profile.locator("svg image")).toHaveCount(0);
      await expect(profile.locator("svg text")).toHaveText(renamed.slice(0, 2).toUpperCase());
      await expect.poll(() => savedProfile(page)).toEqual({ name: renamed, avatar: "" });
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
