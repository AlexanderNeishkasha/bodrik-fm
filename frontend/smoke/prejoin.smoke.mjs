import { expect, test } from "@playwright/test";

test("prejoin camera expands right without moving the device controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.cameraRequests = 0;
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    /** Count camera access so a hidden preview cannot acquire video on startup. */
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints.video) window.cameraRequests++;
      return acquire(constraints);
    };
  });
  await page.goto(`/room/${encodeURIComponent(process.env.SMOKE_ROOM || "chopper")}`);
  const camera = page.getByRole("combobox", { name: "Камера", exact: true });
  const microphone = page.getByRole("combobox", { name: "Микрофон", exact: true });
  const name = page.getByRole("textbox", { name: "Введите имя" });
  const desktopCard = await page.locator("form").boundingBox();
  expect(desktopCard.width).toBeLessThan(1440);
  expect(await page.locator("form").evaluate(node => getComputedStyle(node).borderTopWidth)).toBe("1px");
  await expect(camera).toBeDisabled();
  await expect(page.locator("form [data-camera-on] > [aria-hidden=true]")).toBeHidden();
  await expect(page.locator("form video")).toHaveCount(0);
  const initial = await microphone.boundingBox();
  expect(await page.evaluate(() => window.cameraRequests)).toBe(0);
  await page.getByRole("button", { name: "Камера выключена", exact: true }).click();
  await expect(camera).toBeEnabled();
  await expect(page.locator("form video")).toBeVisible();
  const enabled = await microphone.boundingBox();
  expect(enabled.x).toBeCloseTo(initial.x, 0);
  expect(enabled.width).toBeLessThan(initial.width / 1.8);
  const nameEnabled = await name.boundingBox();
  const preview = await page.locator("form video").boundingBox();
  expect(preview.x).toBeGreaterThan(enabled.x + enabled.width);
  await page.getByRole("button", { name: "Камера включена", exact: true }).click();
  await expect(camera).toBeDisabled();
  const disabled = await microphone.boundingBox();
  expect(disabled.x).toBeCloseTo(enabled.x, 0);
  expect(disabled.y).toBeCloseTo(enabled.y, 0);
  expect(disabled.width).toBeGreaterThan(enabled.width * 1.8);
  expect((await name.boundingBox()).y).toBeCloseTo(nameEnabled.y, 0);
  await page.getByRole("button", { name: "Камера выключена", exact: true }).click();
  await expect(camera).toBeEnabled();
  await expect(page.locator("form video")).toBeVisible();
  expect((await microphone.boundingBox()).x).toBeCloseTo(enabled.x, 0);

  const layout = page.locator("form [data-camera-on]");
  expect(await layout.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await layout.evaluate((node) => getComputedStyle(node).transitionDuration)).toContain("0.26s");
  await page.getByRole("button", { name: "Камера включена", exact: true }).click();
  await expect.poll(async () => (await microphone.boundingBox()).width).toBeCloseTo(disabled.width, 0);
  await page.getByRole("button", { name: "Камера выключена", exact: true }).click();
  await expect.poll(async () => (await microphone.boundingBox()).width).toBeCloseTo(enabled.width, 0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileControls = await microphone.boundingBox();
  const mobilePreview = await page.locator("form video").boundingBox();
  expect(mobilePreview.y).toBeGreaterThan(mobileControls.y + mobileControls.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const viewport of [{ width: 390, height: 844 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    for (const cameraOn of [true, false]) {
      if (!cameraOn) await page.getByRole("button", { name: "Камера включена", exact: true }).click();
      const card = await page.locator("form").boundingBox();
      expect(card.x).toBe(0);
      expect(card.y).toBe(0);
      expect(card.width).toBe(viewport.width);
      expect(card.height).toBeGreaterThanOrEqual(viewport.height);
      expect(await page.locator("form").evaluate(node => {
        const style = getComputedStyle(node);
        return [style.borderTopWidth, style.borderRadius, style.boxShadow];
      })).toEqual(["0px", "0px", "none"]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await page.getByRole("button", { name: "Присоединиться к встрече", exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "Присоединиться к встрече", exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Камера выключена", exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
  }
});
