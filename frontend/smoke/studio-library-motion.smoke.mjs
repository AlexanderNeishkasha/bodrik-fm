import { expect, test } from "@playwright/test";
import { studioLibraryFixture } from "./studioLibraryFixture.mjs";

let fixture;
const runtimeErrors = new WeakMap();
test.afterEach(({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });
test.use({ permissions: [] });
test.beforeAll(async () => { fixture = await studioLibraryFixture(); });
test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => {
    window.fadeStarts = [];
    const original = Element.prototype.animate;
    /** Record real animation starts, without replacing playback or completion behavior. */
    Element.prototype.animate = function (frames, options) {
      if (this.dataset.libraryPresence) window.fadeStarts.push({ key: this.dataset.libraryPresence, frames, options });
      const animation = original.call(this, frames, options);
      if (window.pauseExits && frames.at(-1).opacity === "0") animation.pause();
      return animation;
    };
  });
  await page.setContent(fixture);
  await expect(page.getByRole("searchbox")).toBeVisible();
});

test("Magi → Magic keeps Magical's node and never replays its fade", async ({ page }) => {
  await page.evaluate(() => window.replaceLibraryTracks([
    { id: 5, filename: "Magical.mp3" }, { id: 6, filename: "Magistrate.mp3" },
  ]));
  const survivor = page.locator('[data-library-presence="track:5"]');
  await expect(survivor).toBeVisible();
  await expect.poll(() => survivor.evaluate(node => node.getAnimations().length)).toBe(0);
  await page.evaluate(() => {
    window.survivor = document.querySelector('[data-library-presence="track:5"]');
    window.fadeStarts = [];
  });
  const search = page.getByRole("searchbox");
  await search.fill("Magi");
  await search.fill("Magic");
  await expect(survivor.locator("mark")).toHaveText("Magic");
  await expect(search).toBeFocused();
  expect(await survivor.evaluate(node => node === window.survivor)).toBe(true);
  expect(await survivor.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
  expect(await page.evaluate(() => window.fadeStarts.filter(item => item.key === "track:5"))).toEqual([]);
  const departing = page.locator('[data-library-presence="track:6"]');
  await expect(departing).toHaveAttribute("data-exiting", "true");
  await expect(departing).toHaveAttribute("aria-hidden", "true");
  expect(await departing.evaluate(node => node.inert)).toBe(true);
  await expect(departing.locator("button").first()).toBeDisabled();
  await expect(departing).toHaveCount(0);
  expect(await survivor.evaluate(node => node === window.survivor && node.getAnimations().length === 0)).toBe(true);
});

test("new matches fade in; departing matches and empty states fade out", async ({ page }) => {
  const search = page.getByRole("searchbox");
  await search.fill("Magic");
  const message = page.locator('[data-library-presence="message:search-empty"]');
  await expect(page.locator("aside").getByRole("status")).toHaveText("Ничего не найдено.");
  await page.evaluate(() => window.replaceLibraryTracks([{ id: 5, filename: "Magical.mp3" }]));
  const row = page.locator('[data-library-presence="track:5"]');
  await expect(row).toBeVisible();
  const start = await page.evaluate(() => window.fadeStarts.find(item => item.key === "track:5"));
  expect(start.frames).toEqual([{ opacity: "0" }, { opacity: "1" }]);
  expect(start.options.duration).toBe(150);
  await expect(message).toHaveCount(0);
  await page.evaluate(() => window.replaceLibraryTracks([]));
  await expect(row).toHaveAttribute("data-exiting", "true");
  await row.locator("button").first().evaluate(button => button.click());
  expect(await page.evaluate(() => window.libraryActions)).toEqual([]);
  await expect(row).toHaveCount(0);
});

test("a match returning mid-exit reverses the fade on the same node", async ({ page }) => {
  await page.evaluate(() => window.replaceLibraryTracks([{ id: 5, filename: "Magical.mp3" }]));
  const row = page.locator('[data-library-presence="track:5"]');
  await expect(row).toBeVisible();
  await expect.poll(() => row.evaluate(node => node.getAnimations().length)).toBe(0);
  await page.evaluate(() => { window.pauseExits = true; });
  await page.getByRole("searchbox").fill("other");
  await expect(row).toHaveAttribute("data-exiting", "true");
  await row.evaluate(node => { window.departing = node; window.pauseExits = false; });
  await page.getByRole("searchbox").fill("Magic");
  await expect(row).not.toHaveAttribute("data-exiting");
  expect(await row.evaluate(node => node === window.departing && !node.inert)).toBe(true);
  await expect(row.locator("button").first()).toBeEnabled();
  await expect.poll(() => row.evaluate(node => node.getAnimations().length)).toBe(0);
  await expect(row).toHaveCount(1);
});

test("categories fade without copying their songs into outgoing search previews", async ({ page }) => {
  const category = page.locator('[data-library-presence="section:10"]');
  await expect(category).toBeVisible();
  await page.getByRole("searchbox").fill("forest");
  await expect(category).toHaveAttribute("data-exiting", "true");
  await expect(category.getByText("Battle in the Forest", { exact: true })).toHaveCount(0);
  await expect(category).toHaveCount(0);
  await page.getByRole("searchbox").fill("");
  await expect(category).toBeVisible();
  expect(await page.evaluate(() => window.fadeStarts.filter(item => item.key === "section:10").length)).toBe(3);
});

test("reduced motion removes departures immediately and creates no animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { window.fadeStarts = []; });
  await page.getByRole("searchbox").fill("forest");
  await expect(page.locator('[data-library-presence^="section:"]')).toHaveCount(0);
  await page.getByRole("searchbox").fill("missing");
  await expect(page.locator('[data-library-presence^="track:"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.fadeStarts)).toEqual([]);
  await page.getByRole("searchbox").fill("");
  await expect(page.getByText("Battle category", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fadeStarts)).toEqual([]);
});

test("switching to reduced motion during a paused departure releases it", async ({ page }) => {
  await page.evaluate(() => { window.pauseExits = true; });
  await page.getByRole("searchbox").fill("missing");
  const row = page.locator('[data-library-presence="track:2"]');
  await expect(row).toHaveAttribute("data-exiting", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(row).toHaveCount(0);
  await expect(page.locator('[data-exiting="true"]')).toHaveCount(0);
});

test("unmount cancels unfinished animations without late callbacks", async ({ page }) => {
  await page.evaluate(() => { window.pauseExits = true; });
  await page.getByRole("searchbox").fill("missing");
  const row = page.locator('[data-library-presence="track:2"]');
  await expect(row).toHaveAttribute("data-exiting", "true");
  await row.evaluate(node => { window.retiredAnimation = node.getAnimations()[0]; });
  await page.evaluate(() => window.unmountLibraryFixture());
  expect(await page.evaluate(() => window.retiredAnimation.playState)).toBe("idle");
  await expect(page.locator("[data-library-presence]")).toHaveCount(0);
});
