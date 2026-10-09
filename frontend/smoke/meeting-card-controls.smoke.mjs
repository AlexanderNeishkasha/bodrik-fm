import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

test("card fullscreen follows video and double click does not select text", async ({ page }) => {
  const driver = nextDriver(page);
  const name = `Card${Date.now().toString(36)}`;
  await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
  await driver.join(name);
  try {
    const card = page.locator("article[data-participant-id]").filter({ has: page.locator("footer strong", { hasText: name }) });
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Во весь экран", exact: true })).toHaveCount(0);
    await card.locator("footer strong").dblclick();
    await expect(card).toHaveAttribute("data-focused", "true");
    expect(await page.evaluate(() => window.getSelection().toString())).toBe("");
    await driver.toggleCamera();
    await expect(card.locator("video")).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Во весь экран", exact: true })).toHaveCount(1);
    await driver.toggleCamera();
    await expect(card.getByRole("button", { name: "Во весь экран", exact: true })).toHaveCount(0);
  } finally {
    await driver.leave();
  }
});

test("mobile focus keeps avatar snapshots square while cards change shape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const driver = nextDriver(page);
  const name = `Motion${Date.now().toString(36)}`;
  await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
  await driver.join(name);
  try {
    const card = page.locator("article[data-participant-id]").filter({ has: page.locator("footer strong", { hasText: name }) });
    const avatarName = await card.locator('div[style*="view-transition-name"]').evaluate(node => node.style.viewTransitionName);
    await page.evaluate(name => {
      const start = document.startViewTransition.bind(document);
      window.avatarSamples = [];
      document.startViewTransition = update => {
        const transition = start(update);
        transition.ready.then(() => {
          const style = getComputedStyle(document.documentElement, `::view-transition-group(${name})`);
          window.avatarSamples.push({ width: parseFloat(style.width), height: parseFloat(style.height) });
        }).catch(() => {});
        return transition;
      };
    }, avatarName);
    await card.locator("footer strong").dblclick();
    await expect(card).toHaveAttribute("data-focused", "true");
    await expect.poll(() => page.evaluate(() => window.avatarSamples.length)).toBe(1);
    await page.waitForTimeout(350);
    await card.locator("footer strong").dblclick();
    await expect(card).not.toHaveAttribute("data-focused", "true");
    await expect.poll(() => page.evaluate(() => window.avatarSamples.length)).toBe(2);
    for (const sample of await page.evaluate(() => window.avatarSamples)) {
      expect(sample.width).toBeGreaterThan(0);
      expect(Math.abs(sample.width - sample.height)).toBeLessThan(1);
    }
  } finally {
    await driver.leave();
  }
});
