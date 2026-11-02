import { expect, test } from "@playwright/test";
import { smokeRoom } from "./smokeRooms.mjs";

for (const scenario of [
  { name: "permission denial", error: "NotAllowedError", message: "Permission denied by user", expected: "Доступ не предоставлен" },
  { name: "unrelated capture failure", error: "NotReadableError", message: "Capture device unavailable", expected: "Capture device unavailable" },
]) {
  test(`screen sharing feedback: ${scenario.name}`, async ({ page }) => {
    await page.addInitScript(({ error, message }) => {
      /** Simulate the browser rejecting capture without opening a native picker. */
      navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException(message, error); };
    }, scenario);
    await page.goto(`/room/${encodeURIComponent(smokeRoom())}`);
    await page.getByRole("textbox", { name: "Введите имя" }).fill(`permission-${Date.now()}`);
    await page.getByRole("button", { name: "Присоединиться к встрече" }).click();
    await expect(page.locator("main[data-meeting-status=admitted]")).toBeVisible();
    await page.getByRole("button", { name: "Демонстрация экрана", exact: true }).click();
    await expect(page.locator("main[data-meeting-status=admitted]").getByRole("alert")).toHaveText(scenario.expected);
    await expect(page.locator("main[data-meeting-status=admitted]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Демонстрация экрана", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Покинуть встречу", exact: true }).click();
    const leave = page.getByRole("menuitem", { name: "Выйти из встречи", exact: true });
    if (await leave.isVisible()) await leave.click();
  });
}
