import { expect, test } from "@playwright/test";

import { devOrigins } from "../devOrigins.mjs";

const PLAYER_ORIGIN = process.env.SMOKE_PLAYER_BASE_URL || `https://${devOrigins().host}`;

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
    await route.fulfill({ json: payload, headers: { "Access-Control-Allow-Origin": PLAYER_ORIGIN, "Access-Control-Allow-Credentials": "true" } });
    if (body) socket?.send(JSON.stringify(state));
  });
  await page.goto(`${PLAYER_ORIGIN}/studio`);
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

/** Locators for the Studio cards these checks compare. */
function studioCards(page) {
  return {
    meeting: page.getByRole("complementary", { name: "Встреча", exact: true }),
    queue: page.getByRole("heading", { name: "Очередь", exact: true }).locator("xpath=ancestor::section[1]"),
    library: page.getByRole("heading", { name: "Библиотека", exact: true }).locator("xpath=ancestor::aside[1]"),
  };
}

/** Commands sent to one Studio meeting endpoint, as their JSON bodies. */
const sent = (commands, endpoint) => commands.filter(command => command.path.endsWith(endpoint)).map(command => command.body);

for (const width of [1280, 900, 390]) {
  test(`Studio meeting card, music output and single volume at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { commands } = await studioFixture(page);
    const { meeting, queue, library } = studioCards(page);
    const card = await meeting.boundingBox();
    const queueBox = await queue.boundingBox();
    const libraryBox = await library.boundingBox();
    // The meeting card heads the queue column; the library sits beside it on desktop and below it otherwise.
    expect(Math.abs(card.x - queueBox.x)).toBeLessThan(1);
    expect(Math.abs(card.width - queueBox.width)).toBeLessThan(1);
    expect(card.y + card.height).toBeLessThanOrEqual(queueBox.y);
    if (width >= 1024) expect(libraryBox.x).toBeGreaterThan(card.x + card.width);
    else expect(libraryBox.y).toBeGreaterThanOrEqual(queueBox.y + queueBox.height);
    await expect(meeting.getByRole("link", { name: "Открыть встречу" })).toHaveAttribute("href", "https://meeting.invalid/room/preview");
    await expect(meeting.getByRole("button", { name: "Скопировать ссылку встречи" })).toContainText("Ссылка для гостей");
    const studio = meeting.getByRole("button", { name: "В студию", exact: true });
    const conference = meeting.getByRole("button", { name: "Во встречу", exact: true });
    await expect(studio).toHaveAttribute("aria-pressed", "true");
    await conference.click();
    await expect(conference).toHaveAttribute("aria-pressed", "true");
    expect(sent(commands, "/music-output")).toEqual([{ output: "conference" }]);
    // One volume control: it drives the meeting music while the music plays there.
    const volume = page.getByRole("slider", { name: "Громкость Бодрик FM во встрече", exact: true });
    await expect(volume).toHaveValue("0.6");
    await volume.fill("0.4");
    await expect.poll(() => sent(commands, "/music-volume").map(body => body.volume)).toContain(0.4);
    await studio.click();
    await expect(studio).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("slider", { name: "Громкость", exact: true })).toBeVisible();
    await expect(page.getByRole("slider")).toHaveCount(2); // Seek plus the single volume control.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("Studio omits meeting controls without entitlement", async ({ page }) => {
  await studioFixture(page, { allowed: false, enabled: false });
  await expect(page.getByRole("complementary", { name: "Встреча", exact: true })).toHaveCount(0);
  await expect(page.getByRole("slider")).toHaveCount(2);
});

test("enabling the meeting in Studio settings shows its card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { commands } = await studioFixture(page, { enabled: false });
  const { meeting } = studioCards(page);
  await expect(meeting).toHaveCount(0);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const settings = page.getByRole("dialog");
  await settings.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Встреча", exact: true }).click();
  const enabled = settings.getByRole("switch", { name: "Включить встречу" });
  await expect(enabled).not.toBeChecked();
  await enabled.focus();
  await enabled.press("Space");
  await expect(enabled).toBeChecked();
  expect(sent(commands, "/api/studio/conference")).toEqual([{ enabled: true }]);
  await page.keyboard.press("Escape");
  await expect(meeting).toBeVisible();
});

test("desktop library stretches as the queue grows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { setQueue } = await studioFixture(page);
  const { queue, library } = studioCards(page);
  const initial = await library.boundingBox();
  setQueue(Array.from({ length: 12 }, (_, index) => ({ id: index + 1, filename: `Track ${index + 1}.mp3` })));
  await expect(queue.locator("ol > li")).toHaveCount(12);
  await expect.poll(async () => (await library.boundingBox()).height).toBeGreaterThan(initial.height);
  await expect.poll(async () => {
    const left = await queue.boundingBox();
    const right = await library.boundingBox();
    return Math.abs(left.y + left.height - right.y - right.height);
  }).toBeLessThan(1);
});

test("desktop queue stretches to a longer library and compacts on phones", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await studioFixture(page, { tracks: Array.from({ length: 15 }, (_, index) => ({ id: index + 1, filename: `Library ${index + 1}.mp3`, section_id: null })) });
  const { queue, library } = studioCards(page);
  await expect(library.getByText("Library 15", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const left = await queue.boundingBox();
    const right = await library.boundingBox();
    return Math.abs(left.y + left.height - right.y - right.height);
  }).toBeLessThan(1);
  expect((await queue.boundingBox()).height).toBeGreaterThan(500);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect.poll(async () => (await queue.boundingBox()).height).toBeLessThan(250);
  const left = await queue.boundingBox();
  expect((await library.boundingBox()).y).toBeGreaterThanOrEqual(left.y + left.height);
});

test("meeting volume debounces rapid input and saves only the latest value", async ({ page }) => {
  const { commands } = await studioFixture(page);
  await studioCards(page).meeting.getByRole("button", { name: "Во встречу", exact: true }).click();
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
  expect(sent(commands, "/music-volume")).toHaveLength(0);
  await expect.poll(() => sent(commands, "/music-volume").map(body => body.volume)).toEqual([0.5]);
  await slider.fill("0.7");
  await expect(slider).toHaveValue("0.7");
  await expect.poll(() => sent(commands, "/music-volume").map(body => body.volume)).toEqual([0.5, 0.7]);
});

test("leaving Studio cancels a pending meeting volume update", async ({ page }) => {
  const { commands } = await studioFixture(page);
  await studioCards(page).meeting.getByRole("button", { name: "Во встречу", exact: true }).click();
  const slider = page.getByRole("slider", { name: "Громкость Бодрик FM во встрече", exact: true });
  await expect(slider).toHaveValue("0.6");
  // Paused, so the 200 ms debounce cannot fire in real time before the navigation lands under load.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1_000);
  await slider.fill("0.8");
  await expect(slider).toHaveValue("0.8");
  await page.getByRole("link", { name: "К списку комнат" }).click();
  await expect(page).toHaveURL(`${PLAYER_ORIGIN}/`);
  await page.clock.fastForward(500);
  expect(sent(commands, "/music-volume")).toHaveLength(0);
});
