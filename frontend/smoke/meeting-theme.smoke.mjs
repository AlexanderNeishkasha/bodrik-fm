import { expect, firefox, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

for (const engine of ["chromium", "firefox"]) {
  test(`meeting restores its saved theme before room state and after refresh: ${engine}`, async ({ browser }) => {
    const owned = engine === "firefox" ? await firefox.launch() : null;
    const context = await (owned || browser).newContext({ ignoreHTTPSErrors: true, permissions: [], reducedMotion: "no-preference" });
    await context.addInitScript(() => {
      if (!localStorage.getItem("bodrik_fm_theme")) localStorage.setItem("bodrik_fm_theme", "midnight");
      /** This theme check requires no physical devices or permission prompts. */
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Unavailable", "NotAllowedError"); };
      window.visibleThemes = [];
      window.themeTransitions = [];
      window.dockThemeTransitions = [];
      document.addEventListener("transitionrun", event => {
        if (event.target.matches("form")) window.themeTransitions.push(event.propertyName);
        if (event.target.matches("nav")) window.dockThemeTransitions.push(event.propertyName);
      }, true);
      /** Sample rendered prejoin frames, including frames before the live room theme arrives. */
      function sample() {
        if (document.querySelector("form [data-camera-on]")) window.visibleThemes.push(document.documentElement.dataset.theme);
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    const page = await context.newPage();
    const driver = nextDriver(page);
    let joined = false;
    let stream;
    await page.routeWebSocket("**/ws/rooms/*/state/public", socket => { stream = socket; });
    try {
      await page.goto(`/room/${encodeURIComponent(process.env.SMOKE_ROOM || "chopper")}`);
      await expect(page.getByRole("textbox", { name: "Введите имя" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.visibleThemes.length)).toBeGreaterThan(0);
      expect(await page.evaluate(() => [...new Set(window.visibleThemes)])).toEqual(["midnight"]);
      await expect.poll(() => Boolean(stream)).toBe(true);
      await expect(page.locator("html")).not.toHaveClass(/theme-transition/);
      stream.send(JSON.stringify({ theme: "aurora" }));
      await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora");
      await expect.poll(() => page.evaluate(() => window.themeTransitions.includes("background-color"))).toBe(true);
      await expect(page.locator("html")).not.toHaveClass(/theme-transition/);
      expect(await page.evaluate(() => localStorage.getItem("bodrik_fm_theme"))).toBe("aurora");
      stream = null;
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Введите имя" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.visibleThemes.length)).toBeGreaterThan(0);
      expect(await page.evaluate(() => [...new Set(window.visibleThemes)])).toEqual(["aurora"]);
      await driver.join(`Theme${engine}${Date.now().toString(36).slice(-4)}`);
      joined = true;
      stream.send(JSON.stringify({ theme: "midnight" }));
      await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
      await expect.poll(() => page.evaluate(() => window.dockThemeTransitions.includes("background-color"))).toBe(true);
      await expect(page.locator("html")).not.toHaveClass(/theme-transition/);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(() => { window.themeTransitions = []; window.dockThemeTransitions = []; });
      stream.send(JSON.stringify({ theme: "crimson" }));
      await expect(page.locator("html")).toHaveAttribute("data-theme", "crimson");
      await expect(page.locator("html")).not.toHaveClass(/theme-transition/);
      expect(await page.evaluate(() => window.themeTransitions)).toEqual([]);
      expect(await page.evaluate(() => window.dockThemeTransitions)).toEqual([]);
      await driver.leave();
      joined = false;
    } finally {
      if (joined) await driver.leave().catch(() => {});
      await context.close();
      await owned?.close();
    }
  });
}
