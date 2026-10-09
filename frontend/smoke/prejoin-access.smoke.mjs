import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

for (const scenario of ["camera missing", "both denied", "both missing", "camera recovers"]) {
  test(`prejoin capture availability: ${scenario}`, async ({ page }) => {
    await page.addInitScript((scenario) => {
      const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.allowCamera = false;
      /** Model unavailable hardware independently of microphone permission. */
      navigator.mediaDevices.getUserMedia = (constraints) => {
        if (scenario.startsWith("both")) return Promise.reject(new DOMException("Unavailable", scenario === "both denied" ? "NotAllowedError" : "NotFoundError"));
        if (constraints.video && !window.allowCamera) return Promise.reject(new DOMException("No camera", "NotFoundError"));
        return acquire(constraints);
      };
    }, scenario);
    const driver = nextDriver(page);
    await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
    await expect(page.getByRole("button", { name: "Камера выключена", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: scenario.startsWith("both") ? "Микрофон выключен" : "Микрофон включён", exact: true })).toBeVisible();
    if (scenario === "camera recovers") {
      await page.evaluate(() => { window.allowCamera = true; });
      await page.getByRole("button", { name: "Камера выключена", exact: true }).click();
      await expect(page.locator("form video")).toBeVisible();
      await expect(page.getByRole("status")).toHaveCount(0);
    }
    await driver.join(`access-${Date.now()}`);
    await expect(page.locator("main[data-meeting-status=admitted]")).toBeVisible();
    await driver.leave();
  });
}

for (const failure of ["NotAllowedError", "NotFoundError"]) {
  test(`camera ${failure} leaves prejoin layout unchanged while waiting and after failure`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript((failure) => {
      const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      /** Hold a camera permission/device failure open long enough to expose any layout flash. */
      navigator.mediaDevices.getUserMedia = (constraints) => constraints.video
        ? new Promise((resolve, reject) => { window.rejectCamera = () => reject(new DOMException("Unavailable", failure)); })
        : acquire(constraints);
    }, failure);
    await page.goto(`/room/${encodeURIComponent(process.env.SMOKE_ROOM || "chopper")}`);
    const camera = page.getByRole("button", { name: "Камера выключена", exact: true });
    const microphone = page.getByRole("combobox", { name: "Микрофон", exact: true });
    await page.getByRole("textbox", { name: "Введите имя" }).fill("DeniedCamera");
    const join = page.getByRole("button", { name: "Присоединиться к встрече", exact: true });
    const before = await microphone.boundingBox();
    await page.evaluate(() => {
      const layout = document.querySelector("form [data-camera-on]");
      window.cameraLayoutStates = [];
      new MutationObserver(records => {
        for (const record of records) window.cameraLayoutStates.push(record.oldValue);
        window.cameraLayoutStates.push(layout.dataset.cameraOn);
      }).observe(layout, { attributes: true, attributeFilter: ["data-camera-on"], attributeOldValue: true });
    });
    await camera.click();
    await expect(camera).toBeDisabled();
    await expect(join).toBeDisabled();
    await page.waitForTimeout(350);
    expect(await microphone.boundingBox()).toEqual(before);
    await expect(page.locator("form [data-camera-on]")).toHaveAttribute("data-camera-on", "false");
    await page.evaluate(() => window.rejectCamera());
    await expect(camera).toBeEnabled();
    await expect(join).toBeEnabled();
    await page.waitForTimeout(350);
    expect(await microphone.boundingBox()).toEqual(before);
    expect(await page.evaluate(() => window.cameraLayoutStates.includes("true"))).toBe(false);
    await expect(page.locator("form video")).toHaveCount(0);
  });
}
