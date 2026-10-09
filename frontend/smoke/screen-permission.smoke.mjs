import { expect, test } from "@playwright/test";

for (const scenario of [
  { name: "Russian denial", language: "ru", error: "NotAllowedError", message: "Permission denied by user", expected: "Доступ не предоставлен" },
  { name: "English denial", language: "en", error: "NotAllowedError", message: "Permission denied by user", expected: "Access not granted" },
  { name: "unrelated capture failure", language: "ru", error: "NotReadableError", message: "Capture device unavailable", expected: "Capture device unavailable" },
]) {
  test(`screen sharing feedback: ${scenario.name}`, async ({ page }) => {
    await page.addInitScript(({ language, error, message }) => {
      localStorage.setItem("meeting.preferences.v1", JSON.stringify({ language }));
      /** Simulate the browser rejecting capture without opening a native picker. */
      navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException(message, error); };
    }, scenario);
    await page.goto(`/room/${encodeURIComponent(process.env.SMOKE_ROOM || "chopper")}`);
    const english = scenario.language === "en";
    await page.getByRole("textbox", { name: english ? "Enter your name" : "Введите имя" }).fill(`permission-${Date.now()}`);
    await page.getByRole("button", { name: english ? "Join meeting" : "Присоединиться к встрече" }).click();
    await expect(page.locator("main[data-meeting-status=admitted]")).toBeVisible();
    await page.getByRole("button", { name: english ? "Share screen" : "Демонстрация экрана", exact: true }).click();
    await expect(page.locator("main[data-meeting-status=admitted]").getByRole("alert")).toHaveText(scenario.expected);
    await expect(page.locator("main[data-meeting-status=admitted]")).toBeVisible();
    await expect(page.getByRole("button", { name: english ? "Share screen" : "Демонстрация экрана", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: english ? "Leave meeting" : "Покинуть встречу", exact: true }).click();
    const leave = page.getByRole("menuitem", { name: english ? "Leave meeting" : "Выйти из встречи", exact: true });
    if (await leave.isVisible()) await leave.click();
  });
}
