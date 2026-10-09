import { expect, test } from "@playwright/test";

/** Mock Studio authority so layout checks never change a real room or user data. */
async function studioFixture(page, { allowed = true, enabled = true, tracks = [] } = {}) {
  const user = { id: 999, role: "user", room_slug: "preview", username: "Preview" };
  const state = { is_playing: false, position: 0, current: null, queue: [], listeners: 0,
    conference_allowed: allowed, conference_enabled: enabled, music_output: "studio", conference_music_volume: 0.6, theme: "emberveil" };
  const commands = [];
  let socket;
  await page.addInitScript(user => localStorage.setItem("bodrik_fm_auth_user", JSON.stringify(user)), user);
  await page.routeWebSocket("**/ws/studio/state*", ws => {
    socket = ws;
    ws.send(JSON.stringify(state));
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    if (body) commands.push({ path, body });
    if (path.endsWith("/music-output") && body) state.music_output = body.output;
    if (path.endsWith("/music-volume") && body) state.conference_music_volume = body.volume;
    if (path === "/api/studio/conference" && body) state.conference_enabled = body.enabled;
    const payload = path === "/api/auth/me" ? user : path === "/api/studio/conference"
      ? { allowed, enabled: state.conference_enabled, invite_url: "https://meeting.invalid/room/preview" }
      : { sections: [], tracks };
    await route.fulfill({ json: payload, headers: { "Access-Control-Allow-Origin": "http://pc.local:3000", "Access-Control-Allow-Credentials": "true" } });
    if (body) socket?.send(JSON.stringify(state));
  });
  await page.goto("http://pc.local:3000/studio");
  await expect(page.getByRole("heading", { name: "Сейчас играет" })).toBeVisible();
  return {
    commands,
    /** Publish queue changes through the same authoritative snapshot transport as Studio. */
    setQueue(queue) {
      state.queue = queue;
      socket.send(JSON.stringify(state));
    },
  };
}

for (const width of [1280, 900, 390]) {
  test(`Studio meeting card, switches and single volume at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { commands } = await studioFixture(page);
    const card = page.getByRole("complementary", { name: "Встреча", exact: true });
    const meeting = card.getByRole("switch", { name: "Встреча включена" });
    const queue = await page.getByRole("heading", { name: "Очередь", exact: true }).locator("xpath=ancestor::section[1]").boundingBox();
    const library = await page.getByRole("heading", { name: "Библиотека", exact: true }).locator("xpath=ancestor::aside[1]").boundingBox();
    const box = await card.boundingBox();
    if (width >= 1024) {
      expect(Math.abs(box.x - queue.x)).toBeLessThan(1);
      expect(Math.abs(box.width - queue.width)).toBeLessThan(1);
      expect(box.y).toBeGreaterThanOrEqual(queue.y + queue.height);
      expect(library.x).toBeGreaterThan(box.x + box.width);
    } else {
      expect(box.y).toBeGreaterThanOrEqual(library.y + library.height);
      expect(Math.abs(box.width - library.width)).toBeLessThan(1);
    }
    await expect(meeting).toBeChecked();
    const title = await card.getByRole("heading", { name: "Встреча", exact: true }).boundingBox();
    const toggle = await meeting.boundingBox();
    expect(Math.abs(title.y + title.height / 2 - toggle.y - toggle.height / 2)).toBeLessThan(2);
    const openButton = await card.getByRole("button", { name: "Войти как ведущий" }).boundingBox();
    const copyButton = await card.getByRole("button", { name: "Скопировать ссылку встречи" }).boundingBox();
    await expect(card.getByText("Ссылка для гостей", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Скопировать ссылку встречи" })).toContainText("https://meeting.invalid/room/preview");
    expect(copyButton.height).toBeLessThan(openButton.height);
    const label = await card.getByText("Музыка во встрече", { exact: true }).boundingBox();
    const hint = await card.getByText("Сейчас играет в Studio", { exact: true }).boundingBox();
    expect(hint.y - label.y - label.height).toBeLessThan(8);
    expect(openButton.y).toBeGreaterThan(hint.y + hint.height);
    const music = card.getByRole("switch", { name: "Музыка во встрече" });
    await expect(music).not.toBeChecked();
    await music.click();
    await expect(music).toBeChecked();
    await expect(card.getByText("Сейчас играет во встрече")).toBeVisible();
    const volume = page.getByRole("slider", { name: "Громкость Бодрик FM во встрече", exact: true });
    await expect(volume).toHaveValue("0.6");
    await volume.fill("0.4");
    await expect.poll(() => commands.some(command => command.path.endsWith("/music-volume") && command.body.volume === 0.4)).toBe(true);
    await music.click();
    await expect(music).not.toBeChecked();
    await expect(card.getByText("Сейчас играет в Studio")).toBeVisible();
    await expect(page.getByRole("slider", { name: "Громкость", exact: true })).toBeVisible();
    await expect(page.getByRole("slider")).toHaveCount(2); // Seek plus the single volume control.
    await meeting.click();
    await expect(meeting).not.toBeChecked();
    await expect(music).toBeHidden();
    await expect(card.getByRole("button", { name: "Войти как ведущий" })).toBeHidden();
    await meeting.click();
    await expect(meeting).toBeChecked();
    await expect(music).toBeVisible();
    await expect(card.getByRole("button", { name: "Скопировать ссылку встречи" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("Studio omits meeting controls without entitlement", async ({ page }) => {
  await studioFixture(page, { allowed: false, enabled: false });
  await expect(page.getByRole("complementary", { name: "Встреча", exact: true })).toHaveCount(0);
  await expect(page.getByRole("slider")).toHaveCount(2);
});

test("meeting switches support keyboard with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await studioFixture(page, { enabled: false });
  const card = page.getByRole("complementary", { name: "Встреча", exact: true });
  const meeting = card.getByRole("switch", { name: "Встреча включена" });
  await meeting.focus();
  await meeting.press("Space");
  await expect(meeting).toBeChecked();
  const music = card.getByRole("switch", { name: "Музыка во встрече" });
  await expect(music).toBeVisible();
  const transition = await music.evaluate(element => getComputedStyle(element.closest('[class*="actionsRegion"]')).transitionDuration);
  expect(transition).toBe("0s");
});

test("desktop library stretches as the queue grows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { setQueue } = await studioFixture(page);
  const library = page.getByRole("heading", { name: "Библиотека", exact: true }).locator("xpath=ancestor::aside[1]");
  const meeting = page.getByRole("complementary", { name: "Встреча", exact: true });
  const initial = await library.boundingBox();
  setQueue(Array.from({ length: 12 }, (_, index) => ({ id: index + 1, filename: `Track ${index + 1}.mp3` })));
  await expect(page.getByRole("heading", { name: "Очередь", exact: true }).locator("xpath=ancestor::section[1]").locator("ol > li")).toHaveCount(12);
  await expect.poll(async () => (await library.boundingBox()).height).toBeGreaterThan(initial.height);
  await expect.poll(async () => {
    const left = await meeting.boundingBox();
    const right = await library.boundingBox();
    return Math.abs(left.y + left.height - right.y - right.height);
  }).toBeLessThan(1);
});

test("desktop queue stretches and keeps meeting at the bottom of a longer library", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await studioFixture(page, { tracks: Array.from({ length: 15 }, (_, index) => ({ id: index + 1, filename: `Library ${index + 1}.mp3`, section_id: null })) });
  const queue = page.getByRole("heading", { name: "Очередь", exact: true }).locator("xpath=ancestor::section[1]");
  const library = page.getByRole("heading", { name: "Библиотека", exact: true }).locator("xpath=ancestor::aside[1]");
  const meeting = page.getByRole("complementary", { name: "Встреча", exact: true });
  await expect(library.getByText("Library 15", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const left = await meeting.boundingBox();
    const right = await library.boundingBox();
    return Math.abs(left.y + left.height - right.y - right.height);
  }).toBeLessThan(1);
  expect((await queue.boundingBox()).height).toBeGreaterThan(500);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect.poll(async () => (await queue.boundingBox()).height).toBeLessThan(250);
  const right = await library.boundingBox();
  expect((await meeting.boundingBox()).y).toBeGreaterThanOrEqual(right.y + right.height);
});

test("meeting volume debounces rapid input and saves only the latest value", async ({ page }) => {
  const { commands } = await studioFixture(page);
  const card = page.getByRole("complementary", { name: "Встреча", exact: true });
  await card.getByRole("switch", { name: "Музыка во встрече" }).click();
  const slider = page.getByRole("slider", { name: "Громкость Бодрик FM во встрече", exact: true });
  await expect(slider).toHaveValue("0.6");
  await slider.evaluate(element => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const value of ["0.1", "0.2", "0.3", "0.4", "0.5"]) {
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await expect(slider).toHaveValue("0.5");
  expect(commands.filter(command => command.path.endsWith("/music-volume"))).toHaveLength(0);
  await expect.poll(() => commands.filter(command => command.path.endsWith("/music-volume")).map(command => command.body.volume)).toEqual([0.5]);
  await slider.fill("0.7");
  await expect(slider).toHaveValue("0.7");
  await expect.poll(() => commands.filter(command => command.path.endsWith("/music-volume")).map(command => command.body.volume)).toEqual([0.5, 0.7]);
});

test("leaving Studio cancels a pending meeting volume update", async ({ page }) => {
  const { commands } = await studioFixture(page);
  await page.getByRole("complementary", { name: "Встреча", exact: true }).getByRole("switch", { name: "Музыка во встрече" }).click();
  const slider = page.getByRole("slider", { name: "Громкость Бодрик FM во встрече", exact: true });
  await expect(slider).toHaveValue("0.6");
  await page.clock.install();
  await slider.fill("0.8");
  await expect(slider).toHaveValue("0.8");
  await page.getByRole("link", { name: "К списку комнат" }).click();
  await expect(page).toHaveURL("http://pc.local:3000/");
  await page.clock.fastForward(500);
  expect(commands.filter(command => command.path.endsWith("/music-volume"))).toHaveLength(0);
});
