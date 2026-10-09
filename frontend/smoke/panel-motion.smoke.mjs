import { expect, test } from "@playwright/test";

import { nextDriver } from "./meetingDriver.mjs";

test("sidebar close buttons animate the outgoing panel and respect reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const start = document.startViewTransition.bind(document);
    window.panelTransitions = [];
    /** Observe which visible sidebar disappears inside the browser's transition update. */
    document.startViewTransition = (change) => {
      const visible = [...document.querySelectorAll("aside")].filter((node) => !node.hidden).map((node) => node.style.viewTransitionName);
      const transition = start(change);
      window.lastPanelTransition = transition;
      transition.ready.then(() => {
        const remaining = [...document.querySelectorAll("aside")].filter((node) => !node.hidden).map((node) => node.style.viewTransitionName);
        window.panelTransitions.push({ closed: visible.filter((name) => !remaining.includes(name)) });
      }).catch(() => {});
      return transition;
    };
  });
  const driver = nextDriver(page);
  await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
  await driver.join(`Motion${Date.now().toString(36).slice(-4)}`);
  const controls = page.getByRole("navigation", { name: "Управление встречей" });
  for (const [label, closeLabel, transitionName] of [
    ["Чат", "Закрыть чат", "meeting-chat"],
    ["Участники", "Закрыть участников", "meeting-participants"],
  ]) {
    await controls.getByRole("button", { name: label, exact: true }).click();
    const panel = page.getByRole("complementary", { name: label, exact: true });
    await expect(panel).toBeVisible();
    await page.evaluate(() => window.lastPanelTransition?.finished);
    await page.evaluate(() => { window.panelTransitions = []; });
    await panel.getByRole("button", { name: closeLabel, exact: true }).click();
    await expect(panel).toBeHidden();
    await expect.poll(() => page.evaluate((name) => window.panelTransitions.some((entry) =>
      entry.closed.includes(name)
    ), transitionName)).toBe(true);
    await page.evaluate(() => window.lastPanelTransition?.finished);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { window.panelTransitions = []; });
  await controls.getByRole("button", { name: "Чат", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть чат", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Чат", exact: true })).toBeHidden();
  expect(await page.evaluate(() => window.panelTransitions)).toEqual([]);
  await driver.leave();
});
