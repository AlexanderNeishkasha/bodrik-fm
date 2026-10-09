import { expect, test } from "@playwright/test";
import { THEME_NAMES } from "../app/lib/theme.js";
import { studioLibraryFixture } from "./studioLibraryFixture.mjs";

test.use({ permissions: [] });
const runtimeErrors = new WeakMap();
test.beforeEach(({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });

let fixture;
test.beforeAll(async () => { fixture = await studioLibraryFixture(); });

for (const width of [390, 1280]) {
  test(`library search is full width below controls and filters locally: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests = [];
    page.on("request", request => requests.push(request.url()));
    await page.setContent(fixture);
    const panel = page.locator("aside");
    const search = page.getByRole("searchbox", { name: "Поиск по библиотеке" });
    await expect(search).toBeVisible();
    const searchBox = await search.boundingBox();
    const headerBox = await page.getByRole("button", { name: "Редактировать библиотеку" }).boundingBox();
    const panelContent = await panel.evaluate(element => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
        width: box.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
          - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    });
    expect(searchBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
    expect(Math.abs(searchBox.x - panelContent.left)).toBeLessThan(1);
    expect(Math.abs(searchBox.width - panelContent.width)).toBeLessThan(1);
    await expect(page.getByText("Battle category", { exact: true })).toBeVisible();
    await expect(page.getByText("Песня о ЛЕСЕ", { exact: true })).toHaveCount(0);
    requests.length = 0;

    await search.fill("FOREST");
    await expect(page.getByText("Battle in the Forest", { exact: true })).toBeVisible();
    await expect(page.getByText("Quiet forest", { exact: true })).toBeVisible();
    await expect(panel.locator("mark")).toHaveText(["Forest", "forest"]);
    await expect(page.getByText("Battle category", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Collapsed category", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Night", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Воспроизвести", exact: true }).first().click();
    await page.getByRole("button", { name: "В очередь", exact: true }).first().click();
    expect(await page.evaluate(() => window.libraryActions)).toEqual([["play", 1], ["queue", 1]]);

    await search.fill("лесе");
    await expect(page.getByText("Песня о ЛЕСЕ", { exact: true })).toBeVisible();
    await expect(panel.locator("mark")).toHaveText(["ЛЕСЕ"]);
    await expect(page.getByRole("button", { name: "Воспроизвести", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Редактировать библиотеку" }).click();
    await page.getByRole("button", { name: "Переименовать", exact: true }).click();
    expect(await page.evaluate(() => window.libraryActions.at(-1))).toEqual(["rename", 3]);
    await expect(page.getByRole("button", { name: "Удалить", exact: true })).toBeVisible();

    await search.fill("nonexistent song");
    await expect(page.locator("aside").getByRole("status")).toHaveText("Ничего не найдено.");
    await expect(page.getByText("Battle category", { exact: true })).toHaveCount(0);
    await search.fill("  ");
    await expect(page.getByText("Battle category", { exact: true })).toBeVisible();
    await expect(page.getByText("Collapsed category", { exact: true })).toBeVisible();
    await expect(page.getByText("Night", { exact: true })).toBeVisible();
    await expect(page.getByText("Песня о ЛЕСЕ", { exact: true })).toHaveCount(0);
    await search.fill("");
    await expect(panel.locator("mark")).toHaveCount(0);
    await expect(page.locator("aside").getByRole("status")).toHaveCount(0);
    expect(requests.filter(url => /\/api\/|\/ws\//.test(url))).toEqual([]);
  });
}

test("library search follows new canonical data and handles an empty library", async ({ page }) => {
  await page.setContent(fixture);
  const search = page.getByRole("searchbox");
  await expect(search).toBeVisible();
  await search.fill("new song");
  await expect(page.locator("aside").getByRole("status")).toHaveText("Ничего не найдено.");
  await page.evaluate(() => window.replaceLibraryTracks([{ id: 5, filename: "New song.mp3", section_id: 20 }]));
  await expect(page.getByText("New song", { exact: true })).toBeVisible();
  await expect(page.locator("aside").getByRole("status")).toHaveCount(0);
  await page.evaluate(() => window.replaceLibraryTracks([]));
  await expect(page.locator("aside").getByRole("status")).toHaveText("Ничего не найдено.");
});

test("library highlights repeat matches, treat punctuation literally and escape song names", async ({ page }) => {
  await page.setContent(fixture);
  const search = page.getByRole("searchbox");
  const panel = page.locator("aside");
  await expect(search).toBeVisible();
  await page.evaluate(() => window.replaceLibraryTracks([{ id: 6, filename: "Forest forest [Forest].mp3" }]));
  await search.fill("forest");
  await expect(panel.locator("mark")).toHaveText(["Forest", "forest", "Forest"]);
  await expect(page.getByText("Forest forest [Forest]", { exact: true })).toBeVisible();
  await search.fill("[Forest]");
  await expect(panel.locator("mark")).toHaveText(["[Forest]"]);
  await page.evaluate(() => window.replaceLibraryTracks([{ id: 7, filename: "<img src=x onerror=alert(1)> forest.mp3" }]));
  await search.fill("forest");
  await expect(page.getByText("<img src=x onerror=alert(1)> forest", { exact: true })).toBeVisible();
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(panel.locator("mark")).toHaveText(["forest"]);
});

for (const theme of THEME_NAMES) {
  test(`highlighted song text stays readable: ${theme}`, async ({ page }) => {
    await page.setContent(fixture);
    await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
    await page.getByRole("searchbox").fill("forest");
    const highlight = page.locator("aside mark").first();
    await expect(highlight).toBeVisible();
    const contrast = await highlight.evaluate(element => {
      const context = document.createElement("canvas").getContext("2d");
      /** Resolve the browser's actual theme colour to sRGB relative luminance. */
      function luminance(color) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      }
      const style = getComputedStyle(element);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  });
}
