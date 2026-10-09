import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

for (const width of [1280, 390]) {
  test(`branded exit rejoins immediately at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const driver = nextDriver(page);
    const name = `Rejoin${Date.now().toString(36)}`;
    await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
    await driver.join(name, { video: true });
    const mute = page.getByRole("button", { name: "Выключить микрофон", exact: true });
    await expect(mute).toBeEnabled();
    await mute.focus();
    await mute.press("Space");
    await expect(page.getByRole("button", { name: "Включить микрофон", exact: true })).toBeVisible();
    await driver.leave();
    await expect(page.getByRole("heading", { name: "До встречи!" })).toBeVisible();
    await expect(page.getByRole("link", { name: "На главную Бодрик FM" })).toHaveAttribute("href", "/");
    await page.getByRole("button", { name: "Вернуться во встречу" }).click();
    await expect(page.locator("main[data-meeting-status=admitted]")).toBeVisible();
    const self = page.locator("article[data-participant-id]").filter({ has: page.locator("footer strong", { hasText: name }) });
    await expect(self.locator("video")).toHaveCount(1);
    await expect(self.getByRole("img", { name: "Микрофон выключен" })).toBeVisible();
    await driver.leave();
  });
}

test("connection failure retries without prejoin; missing meetings have home only", async ({ page }) => {
  const driver = nextDriver(page);
  const name = `Retry${Date.now().toString(36)}`;
  let requests = 0;
  await page.route("**/conference/ticket", route => {
    requests++;
    return requests === 1 ? route.fulfill({ status: 503, body: "unavailable" }) : route.continue();
  });
  await page.goto(driver.path(process.env.SMOKE_ROOM || "chopper"));
  await page.getByRole("textbox", { name: "Введите имя" }).fill(name);
  await page.getByRole("button", { name: "Присоединиться к встрече" }).click();
  await expect(page.getByRole("heading", { name: "Не получилось подключиться" })).toBeVisible();
  await page.getByRole("button", { name: "Попробовать снова" }).click();
  await expect(page.locator("main[data-meeting-status=admitted]")).toBeVisible();
  expect(requests).toBe(2);
  await driver.leave();
  await page.unroute("**/conference/ticket");
  await page.route("**/conference/ticket", route => route.fulfill({ status: 404, body: "missing" }));
  await page.route("**/api/rooms/missing-meeting/conference", route => route.fulfill({ json: { enabled: true } }));
  await page.goto(driver.path("missing-meeting"));
  await page.getByRole("textbox", { name: "Введите имя" }).fill(name);
  await page.getByRole("button", { name: "Присоединиться к встрече" }).click();
  await expect(page.getByRole("heading", { name: "Встреча недоступна" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Попробовать снова" })).toHaveCount(0);
  await page.getByRole("link", { name: "На главную Бодрик FM" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("player status routes retain the shared branded destinations", async ({ page }) => {
  for (const [path, title] of [["/404", "Страница не найдена"], ["/500", "Ошибка сервера"], ["/bye", "До встречи!"], ["/meeting-unavailable", "Встреча недоступна"]]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByRole("link", { name: /На главную/ })).toHaveAttribute("href", "/");
  }
});

test("entry lookup failures retry and unavailable invitations use the shared page", async ({ page }) => {
  const driver = nextDriver(page);
  let lookups = 0;
  let offline = true;
  const room = process.env.SMOKE_ROOM || "chopper";
  await page.route(`**/api/rooms/${room}/conference`, route => {
    lookups++;
    return offline ? route.fulfill({ status: 503, body: "offline" }) : route.continue();
  });
  await page.goto(driver.path(room));
  await expect(page.getByRole("heading", { name: "Не получилось подключиться" })).toBeVisible();
  const beforeRetry = lookups;
  offline = false;
  await page.getByRole("button", { name: "Попробовать снова" }).click();
  await expect(page.getByRole("textbox", { name: "Введите имя" })).toBeVisible();
  expect(lookups).toBeGreaterThan(beforeRetry);
  await page.goto(driver.path(`missing${Date.now()}`));
  await expect(page.getByRole("heading", { name: "Встреча недоступна" })).toBeVisible();
  await expect(page.getByRole("link", { name: "На главную Бодрик FM" })).toHaveAttribute("href", "/");
});
