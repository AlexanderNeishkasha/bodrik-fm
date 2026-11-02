import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";
import { smokeRoom } from "./smokeRooms.mjs";

test("browser Back leaves the room for prejoin and a panel closes first", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const driver = nextDriver(page);
  const name = `Back${Date.now().toString(36).slice(-6)}`;
  const admitted = page.locator("main[data-meeting-status=admitted]");
  const joinButton = page.getByRole("button", { name: "Присоединиться к встрече" });
  await page.goto(driver.path(smokeRoom()));
  await driver.join(name);

  // Back returns to prejoin with the just-used profile selected; joining works again.
  await page.goBack();
  await expect(joinButton).toBeVisible();
  await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
  await joinButton.click();
  await admitted.waitFor();

  // On a phone the chat is full screen: Back closes it and keeps the meeting.
  await driver.openChat();
  await expect(page.getByRole("button", { name: "Закрыть чат", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Закрыть чат", exact: true })).toHaveCount(0);
  await expect(admitted).toBeVisible();
  await driver.leave();
});
