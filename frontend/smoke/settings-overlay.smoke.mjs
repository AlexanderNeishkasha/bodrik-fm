import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

test("settings dismisses on backdrop and control menus stay above animated membership changes", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const driver = nextDriver(page);
  const room = process.env.SMOKE_ROOM || "chopper";
  await page.goto(driver.path(room));
  await driver.join(`overlay-${Date.now()}`);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Настройки встречи" });
  await expect(dialog).toBeVisible();
  const rect = await dialog.boundingBox();
  await page.mouse.move(rect.x + 100, rect.y + 30);
  await page.mouse.down();
  await page.mouse.move(4, 4);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Выбор микрофона и динамика", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Микрофоны", exact: true });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((node) => getComputedStyle(node).viewTransitionName)).toBe("meeting-control-menu");
  expect(await page.getByRole("navigation", { name: "Управление встречей" }).evaluate((node) => getComputedStyle(node).viewTransitionName)).toBe("meeting-controls");
  await page.evaluate(() => {
    window.overlayTransitions = 0;
    window.overlayReady = 0;
    const start = document.startViewTransition.bind(document);
    /** Observe the real transition rather than suppressing the animation under test. */
    document.startViewTransition = (...args) => {
      window.overlayTransitions++;
      const transition = start(...args);
      transition.ready.then(() => window.overlayReady++).catch(() => {});
      return transition;
    };
  });
  const other = await browser.newContext({ baseURL: process.env.SMOKE_BASE_URL || "https://pc.local:3443", ignoreHTTPSErrors: true, permissions: ["camera", "microphone"] });
  try {
    const peer = await other.newPage();
    const peerDriver = nextDriver(peer);
    const peerName = `overlay-peer-${Date.now()}`;
    const peerCard = page.locator("article[data-card-key]").filter({ has: page.getByText(peerName, { exact: true }) });
    await peer.goto(peerDriver.path(room));
    await peerDriver.join(peerName);
    await expect(peerCard).toBeVisible();
    await expect(menu).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.overlayReady)).toBeGreaterThan(0);
    // Inspect the generated stylesheet rules without querying transition pseudo-elements (a Chrome crash path).
    const layers = await page.evaluate(() => {
      const result = {};
      /** Read compiled transition stacking rules, including CSS grouping rules. */
      function collect(rules) {
        for (const rule of rules) {
          for (const name of ["meeting-controls", "meeting-control-menu", "meeting-chat"]) {
            if (rule.selectorText?.includes(`::view-transition-group(${name})`) && rule.style.zIndex) result[name] = Number(rule.style.zIndex);
          }
          if (rule.cssRules) collect(rule.cssRules);
        }
      }
      for (const sheet of document.styleSheets) collect(sheet.cssRules);
      return result;
    });
    expect(layers["meeting-control-menu"]).toBeGreaterThan(layers["meeting-controls"]);
    expect(layers["meeting-chat"]).toBeGreaterThan(layers["meeting-control-menu"]);
    await peerDriver.leave();
    await expect(peerCard).toHaveCount(0);
    await expect(menu).toBeVisible();
  } finally { await other.close(); }
  await page.getByRole("button", { name: "Выбор микрофона и динамика", exact: true }).click();
  await driver.leave();
});
