import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";

for (const url of ["http://pc.local:3000/studio", "https://pc.local:3443/room/chopper"]) {
  test(`text selection follows each theme: ${url}`, async ({ page }) => {
    await page.routeWebSocket("**/ws/rooms/*/state/public", () => {});
    await page.goto(url);
    await expect(page.locator("input:not([type]), input[type=text], input[type=password]").first()).toBeVisible();
    for (const filename of readdirSync("app/themes").filter(name => name.endsWith(".css"))) {
      const colors = await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        const input = document.querySelector("input:not([type]), input[type=text], input[type=password]");
        const selection = getComputedStyle(input, "::selection");
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--theme-accent)";
        document.body.append(probe);
        const accent = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const luminances = [selection.color, selection.backgroundColor].map(color => {
          const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        });
        return { background: selection.backgroundColor, accent, contrast: (Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05) };
      }, filename.slice(0, -4));
      expect(colors.background, filename).toBe(colors.accent);
      expect(colors.contrast, filename).toBeGreaterThanOrEqual(4.5);
    }
  });
}
