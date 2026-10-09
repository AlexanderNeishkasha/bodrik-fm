import { expect, firefox, test } from "@playwright/test";
import { MEETING_THEMES } from "../features/meeting/client/theme.mjs";
import { chatColorFixture } from "./chatColorFixture.mjs";

let fixture;
test.beforeAll(async () => { fixture = await chatColorFixture(); });

for (const browserName of ["chromium", "firefox"]) {
  test.describe(browserName, () => {
    let owned;
    test.beforeAll(async () => { if (browserName === "firefox") owned = await firefox.launch(); });
    test.afterAll(async () => { await owned?.close(); });
    for (const theme of MEETING_THEMES) {
      test(`chat text meets normal-text contrast in both directions: ${theme}`, async ({ browser }) => {
        const page = await (owned || browser).newPage({ permissions: [] });
        try {
          await page.setContent(fixture);
          await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
          const messages = page.getByRole("list", { name: "Messages", exact: true }).getByRole("listitem");
          await expect(messages).toHaveCount(2);
          for (let index = 0; index < 2; index++) {
            const text = messages.nth(index).getByText("Hello / Привет — readable chat text", { exact: true });
            await expect(text).toBeVisible();
            const ratio = await text.evaluate(element => {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const context = canvas.getContext("2d");
              /** Let the browser resolve rgb() and color-mix() results to sRGB pixels. */
              function rgb(color) {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
              }
              /** WCAG relative luminance for an opaque sRGB colour. */
              function luminance(channels) {
                const linear = channels.map(value => {
                  const channel = value / 255;
                  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                });
                return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
              }
              const foreground = luminance(rgb(getComputedStyle(element).color));
              const background = luminance(rgb(getComputedStyle(element.parentElement).backgroundColor));
              return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
            });
            expect(ratio, `${theme} ${index === 0 ? "incoming" : "outgoing"} text contrast`).toBeGreaterThanOrEqual(4.5);
          }
        } finally {
          await page.close();
        }
      });
    }
  });
}
