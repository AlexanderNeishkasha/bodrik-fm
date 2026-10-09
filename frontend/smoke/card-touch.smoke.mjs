import { expect, test } from "@playwright/test";

import { nextDriver } from "./meetingDriver.mjs";

test("touch cards reveal controls on one tap and focus only on double tap", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const driver = nextDriver(page);
  try {
    await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
    await driver.join(`Touch${Date.now().toString(36).slice(-4)}`);
    const music = page.locator('article[data-card-key="bodrik-music"]');
    const controls = page.getByRole("navigation", { name: "Управление встречей" });
    for (const width of [320, 390, 600, 780]) {
      await page.setViewportSize({ width, height: 844 });
      const boxes = await controls.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { x: box.x, right: box.right, center: box.y + box.height / 2 };
      }));
      expect(Math.max(...boxes.map((box) => box.center)) - Math.min(...boxes.map((box) => box.center))).toBeLessThan(1);
      expect(Math.min(...boxes.map((box) => box.x))).toBeGreaterThanOrEqual(0);
      expect(Math.max(...boxes.map((box) => box.right))).toBeLessThanOrEqual(width);
      await controls.getByRole("button", { name: "Дополнительно", exact: true }).tap();
      const more = page.getByRole("menu", { name: "Дополнительно", exact: true });
      await expect(more).toBeVisible();
      const menuBox = await more.boundingBox();
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
      await expect(more.getByRole("menuitem", { name: "О программе", exact: true })).toBeInViewport();
      await page.keyboard.press("Escape");
      await expect(more).toBeHidden();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await music.tap({ position: { x: 24, y: 24 } });
    await expect(music).not.toHaveAttribute("data-focused", "true");
    const actions = music.getByRole("button", { name: "Действия", exact: true });
    await expect.poll(() => actions.evaluate((node) => getComputedStyle(node.parentElement).opacity)).toBe("1");
    await actions.tap();
    const menu = page.getByRole("menu", { name: "Действия", exact: true });
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((node) => node.closest("article") === null)).toBe(true);
    const menuBox = await menu.boundingBox();
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(844);
    await expect(music).not.toHaveAttribute("data-focused", "true");
    await actions.tap();
    // Separate the single tap from the following double-tap gesture.
    await page.waitForTimeout(400);
    await music.tap({ position: { x: 24, y: 24 } });
    await music.tap({ position: { x: 24, y: 24 } });
    await expect(music).toHaveAttribute("data-focused", "true");
    await page.waitForTimeout(400);
    await music.tap({ position: { x: 24, y: 24 } });
    await music.tap({ position: { x: 24, y: 24 } });
    await expect(music).not.toHaveAttribute("data-focused", "true");
    await driver.leave();
  } finally {
    await context.close();
  }
});
