import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";

test("meeting theme reaches the main domain before paint despite stale local storage", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  let stream;
  try {
    // Use the built export under virtual production hosts; no production requests are sent.
    await context.route(/^https:\/\/(?:meet\.)?bodrik\.fm\//, async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/rooms/chopper/conference") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) }); return;
      }
      if (url.pathname.startsWith("/api/")) { await route.fulfill({ status: 200, contentType: "application/json", body: "[]" }); return; }
      const root = fileURLToPath(new URL("../out/", import.meta.url));
      const relative = url.pathname.startsWith("/room/") ? "meeting.html" : url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      let target = path.resolve(root, relative);
      expect(target.startsWith(root)).toBe(true);
      if (!existsSync(target) || statSync(target).isDirectory()) target += route.request().headers().rsc === "1" ? ".txt" : ".html";
      await route.fulfill({ path: target });
    });
    await context.routeWebSocket(/.*/, socket => { if (socket.url().includes("/ws/rooms/")) stream = socket; });
    await context.addInitScript(() => {
      try { localStorage.setItem("bodrik_fm_theme", "midnight"); } catch {}
      window.firstTheme = null;
      /** Capture the theme applied before the first rendered frame. */
      requestAnimationFrame(() => { window.firstTheme = document.documentElement.dataset.theme; });
    });
    const page = await context.newPage();
    await page.goto("https://meet.bodrik.fm/room/chopper");
    await expect.poll(() => Boolean(stream)).toBe(true);
    stream.send(JSON.stringify({ theme: "aurora" }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora");
    const cookies = await context.cookies("https://bodrik.fm/");
    expect(cookies.find(cookie => cookie.name === "bodrik_fm_theme")).toMatchObject({ value: "aurora", domain: ".bodrik.fm", secure: true, sameSite: "Lax" });
    await page.goto("https://bodrik.fm/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora");
    expect(await page.evaluate(() => window.firstTheme)).toBe("aurora");
    expect(await page.evaluate(() => localStorage.getItem("bodrik_fm_theme"))).toBe("aurora");
  } finally { await context.close(); }
});
