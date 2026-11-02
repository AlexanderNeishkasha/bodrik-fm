import { expect, test } from "@playwright/test";

import { FOCUS_VIEWPORTS, checkStableFocus } from "./meetingFocusChecks.mjs";
import { ROOM, card, cardAction, leaveAll, openParticipant } from "./meetingParticipants.mjs";

// Steps share two joined participants; each is its own test so every step keeps the short smoke limit.
test.describe.serial("two participants: media, chat and leave", { tag: "@push" }, () => {
  const suffix = Date.now().toString(36).slice(-4);
  const nameA = `SmokeA${suffix}`;
  const nameB = `SmokeB${suffix}`;
  let a;
  let b;
  let musicMenu;

  test.beforeAll(async ({ browser }) => {
    a = await openParticipant(browser, nameA);
    musicMenu = a.page.locator('article[data-card-key="bodrik-music"]').getByRole("button", { name: "Действия", exact: true });
    await a.page.locator('article[data-card-key="bodrik-music"]').hover();
    await musicMenu.click();
    await expect(a.page.getByRole("menu", { name: "Действия", exact: true })).toBeVisible();
    b = await openParticipant(browser, nameB);
  });

  test.afterAll(async () => {
    const joined = [a, b].filter(Boolean);
    await leaveAll(...joined);
    for (const participant of joined) await participant.context.close();
  });

  test("both see each other and the music participant", async () => {
    await expect(card(a.page, nameB)).toBeVisible();
    await expect(a.page.getByRole("menu", { name: "Действия", exact: true })).toHaveCount(0);
    await expect(card(b.page, nameA)).toBeVisible();
    await expect(a.page.locator('article[data-participant-id="bodrik-music"]')).toHaveCount(1);
    await expect(card(a.page, nameB).locator("video")).toHaveCount(1);
    await expect.poll(() => card(a.page, nameB).locator("video").evaluate((video) =>
      video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0
    ), { message: "remote participant receives decoded video frames" }).toBe(true);
  });

  test("participants visibility follows card actions and dock reopening", async () => {
    await cardAction(a.page, nameB, "Скрыть из сетки");
    await expect(card(a.page, nameB)).toHaveCount(0);
    const controls = a.page.getByRole("navigation", { name: "Управление встречей" });
    await controls.getByRole("button", { name: "Участники", exact: true }).click();
    const panel = a.page.getByRole("complementary", { name: "Участники" });
    await panel.getByRole("button", { name: "Действия: Бодрик FM", exact: true }).click();
    const musicVolume = panel.getByRole("slider", { name: "Громкость", exact: true });
    await musicVolume.focus();
    await musicVolume.press("Home");
    await expect(musicVolume).toHaveValue("0");
    await musicVolume.press("ArrowRight");
    await expect(musicVolume).toHaveValue("1");
    await panel.getByRole("button", { name: `Действия: ${nameB}`, exact: true }).click();
    await panel.getByRole("menuitem", { name: "Показать в сетке", exact: true }).click();
    await expect(card(a.page, nameB)).toBeVisible();
    await panel.getByRole("menuitem", { name: "Скрыть из сетки", exact: true }).click();
    await expect(card(a.page, nameB)).toHaveCount(0);
    await panel.getByRole("button", { name: "Закрыть участников", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await controls.getByRole("button", { name: "Участники", exact: true }).click();
    const rowActions = panel.getByRole("button", { name: `Действия: ${nameB}`, exact: true });
    if (await rowActions.getAttribute("aria-expanded") !== "true") await rowActions.click();
    await panel.getByRole("menuitem", { name: "Показать в сетке", exact: true }).click();
    await expect(card(a.page, nameB)).toBeVisible();
    await panel.getByRole("button", { name: "Закрыть участников", exact: true }).click();
  });

  test("microphone mute is visible to the other participant", async () => {
    await b.driver.toggleMicrophone();
    await expect(card(a.page, nameB).getByRole("img", { name: "Микрофон выключен" })).toBeVisible();
    await b.driver.toggleMicrophone();
    await expect(card(a.page, nameB).getByRole("img", { name: "Микрофон включён" })).toBeVisible();
  });

  test("camera off is visible to the other participant", async () => {
    await b.driver.toggleCamera();
    await expect(card(a.page, nameB).locator("video")).toHaveCount(0);
    await expect(card(a.page, nameB).getByRole("button", { name: "Во весь экран", exact: true })).toHaveCount(0);
    await b.driver.toggleCamera();
    await expect(card(a.page, nameB).locator("video")).toHaveCount(1);
  });

  test("screen video is decoded remotely beside the camera", async () => {
    const controls = b.page.getByRole("navigation", { name: "Управление встречей" });
    await controls.getByRole("button", { name: "Демонстрация экрана", exact: true }).click();
    await expect(card(a.page, nameB)).toHaveCount(2);
    await expect.poll(() => card(a.page, nameB).locator("video").evaluateAll((videos) =>
      videos.length === 2 && videos.every((video) => video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0)
    ), { message: "remote camera and synthetic screen decode independently" }).toBe(true);
    await expect(card(a.page, nameB).getByRole("button", { name: "Во весь экран", exact: true })).toHaveCount(2);
  });

  for (const [layout, viewport] of Object.entries(FOCUS_VIEWPORTS)) {
    test(`${layout} focus round trip keeps decoded video`, async () => {
      await checkStableFocus(a.page, [viewport], { panels: false, fullscreen: false });
    });
    test(`${layout} panels and avatar focus keep decoded video`, async () => {
      await checkStableFocus(a.page, [viewport], { focus: false, fullscreen: false });
    });
  }

  test("fullscreen and picture-in-picture keep decoded video", async () => {
    await checkStableFocus(a.page, [FOCUS_VIEWPORTS.desktop], { focus: false, panels: false });
  });

  test("card focus follows double clicks and screen sharing stops", async () => {
    const controls = b.page.getByRole("navigation", { name: "Управление встречей" });
    await card(a.page, nameB).last().dblclick({ position: { x: 60, y: 60 } });
    // Hover reveals controls; a single click preserves layout and double click toggles focus.
    const region = a.page.getByRole("region", { name: "Участники встречи" });
    await expect(region.locator('article[data-focused="true"]')).toHaveCount(1);
    await expect(region.locator('article[data-focused="true"] video')).toHaveCount(1);
    const music = region.locator('article[data-card-key="bodrik-music"]');
    await music.hover();
    await expect.poll(() => music.getByRole("button", { name: "Действия", exact: true }).evaluate((node) => getComputedStyle(node.parentElement).opacity)).toBe("1");
    await music.click({ position: { x: 24, y: 24 } });
    await expect(music).not.toHaveAttribute("data-focused", "true");
    await expect(music.getByRole("button", { name: "Действия", exact: true })).toBeVisible();
    await music.dblclick({ position: { x: 24, y: 24 } });
    await expect(music).toHaveAttribute("data-focused", "true");
    await music.dblclick({ position: { x: 24, y: 24 } });
    await expect(region.locator('article[data-focused="true"]')).toHaveCount(0);
    await controls.getByRole("button", { name: "Остановить демонстрацию", exact: true }).click();
    await expect(card(a.page, nameB)).toHaveCount(1);
  });

  test("chat works both ways", async () => {
    await a.driver.openChat();
    await b.driver.openChat();
    for (const [from, to, text] of [[a, b, `hello from A ${suffix}`], [b, a, `hello from B ${suffix}`]]) {
      await from.page.getByRole("textbox", { name: "Сообщение" }).fill(text);
      await from.page.getByRole("button", { name: "Отправить" }).click();
      await expect(to.page.getByRole("list", { name: "Сообщения" }).getByText(text)).toBeVisible();
    }
  });

  test("leaving removes the card for the other participant", async () => {
    const closeChat = a.page.getByRole("button", { name: "Закрыть чат", exact: true });
    if (await closeChat.isVisible()) await closeChat.click();
    await a.page.locator('article[data-card-key="bodrik-music"]').hover();
    await musicMenu.click();
    await expect(a.page.getByRole("menu", { name: "Действия", exact: true })).toBeVisible();
    await b.driver.leave();
    await expect(card(a.page, nameB)).toHaveCount(0);
    await expect(a.page.getByRole("menu", { name: "Действия", exact: true })).toHaveCount(0);
    await a.driver.leave();
    await expect(a.page.locator("main[data-meeting-status=admitted]")).toHaveCount(0);
  });

  test("no console errors", () => {
    const errors = [...a.errors, ...b.errors];
    if (errors.length) console.log(["Console errors:", ...errors].join("\n"));
    expect(errors, "console errors").toEqual([]);
  });
});

test("phone: overlays are fullscreen and close on back", async ({ browser }) => {
  const a = await openParticipant(browser, `Phone${Date.now().toString(36).slice(-4)}`, `/room/${encodeURIComponent(ROOM)}`);
  try {
    const page = a.page;
    await page.setViewportSize({ width: 390, height: 844 });
    const url = page.url();
    const controls = page.getByRole("navigation", { name: "Управление встречей" });
    const overlays = [
      ["Чат", page.getByRole("complementary", { name: "Чат" })],
      ["Участники", page.getByRole("complementary", { name: "Участники" })],
      ["Настройки", page.getByRole("dialog", { name: "Настройки встречи" })],
    ];
    for (const [button, overlay] of overlays) {
      await test.step(`${button}: fullscreen, back closes it`, async () => {
        await controls.getByRole("button", { name: button, exact: true }).click();
        await expect(overlay).toBeVisible();
        // Polled: the opening animation briefly scales/slides the overlay.
        await expect.poll(() => overlay.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
        await page.goBack();
        await expect(overlay).toBeHidden();
        expect(page.url()).toBe(url);
        await expect(controls).toBeVisible();
      });
    }
    await page.setViewportSize({ width: 844, height: 240 });
    await controls.getByRole("button", { name: "Участники", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Участники" });
    await expect.poll(() => panel.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 240 });
    const close = panel.getByRole("button", { name: "Закрыть участников" });
    const beforeScroll = await close.boundingBox();
    await panel.getByRole("textbox", { name: "Поиск участников" }).evaluate((node) => { node.parentElement.parentElement.scrollTop = 1000; });
    expect(await panel.getByRole("textbox", { name: "Поиск участников" }).evaluate((node) => node.parentElement.parentElement.scrollTop)).toBeGreaterThan(0);
    expect(await close.boundingBox()).toEqual(beforeScroll);
    await close.click();
    await expect(panel).toBeHidden();
  } finally {
    await leaveAll(a);
    await a.context.close();
  }
});
