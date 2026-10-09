import { expect, test } from "@playwright/test";
import { studioLibraryFixture } from "./studioLibraryFixture.mjs";

let fixture;
test.use({ permissions: [], reducedMotion: "reduce", viewport: { width: 1280, height: 1100 } });
test.beforeAll(async () => { fixture = await studioLibraryFixture({ dragTargets: true }); });

/** Exercise real pointer sensors, including the canonical six-pixel activation threshold. */
async function drag(page, source, target, stationary) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  const before = stationary ? await stationary.boundingBox() : null;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  if (stationary) {
    const after = await stationary.boundingBox();
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  }
  await page.mouse.up();
}

for (const [name, destination, expected] of [
  ["library rows cannot receive or visually sort search results", '[data-library-presence="track:2"]', null],
  ["queue accepts categorized search results", '[data-testid="queue-container"]', "queue-container"],
  ["player accepts categorized search results", '[data-testid="now-playing"]', "now-playing"],
]) {
  test(name, async ({ page }) => {
    await page.setContent(fixture);
    await page.getByRole("searchbox").fill("forest");
    await expect(page.locator('[data-library-presence="section:10"]')).toHaveCount(0);
    const source = page.locator('[data-library-presence="track:1"]');
    const peer = page.locator('[data-library-presence="track:2"]');
    await drag(page, source, page.locator(destination), peer);
    await expect.poll(() => page.evaluate(() => window.libraryDrops.length)).toBe(1);
    expect(await page.evaluate(() => window.libraryDrops[0])).toEqual({ target: expected,
      data: { type: "library", id: 1, filename: "Battle in the Forest.mp3", sectionId: 10, libraryReadOnly: true,
        sortable: expect.any(Object) } });
  });
}

test("clearing a search restores categorized library drop targets", async ({ page }) => {
  await page.setContent(fixture);
  await page.getByRole("searchbox").fill("forest");
  await page.getByRole("searchbox").fill("   ");
  await expect(page.locator('[data-library-presence="section:10"]')).toHaveCount(1);
  const source = page.locator('[data-library-presence="section:10"] [role="button"]').filter({ hasText: "Battle in the Forest" }).last();
  await drag(page, source, page.locator('[data-library-presence="track:2"]'));
  await expect.poll(() => page.evaluate(() => window.libraryDrops.length)).toBe(1);
  const result = await page.evaluate(() => window.libraryDrops[0]);
  expect(result.target).toBe("library-track-2");
  expect(result.data.libraryReadOnly).toBe(false);
});
