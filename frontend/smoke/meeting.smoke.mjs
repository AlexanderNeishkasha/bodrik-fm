import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

import { expect, request, test } from "@playwright/test";

import { checkStableFocus } from "./meetingFocusChecks.mjs";
import { nextDriver } from "./meetingDriver.mjs";

const ROOM = process.env.SMOKE_ROOM || "chopper";

/** Console errors that are known noise from fake devices, not regressions. */
const IGNORED_CONSOLE = [/Microphone meter initialization failed/];

/** A valid solid-color square PNG (RGB, 8-bit) for avatar uploads. */
function solidPng(size) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

/** Local Studio credentials: SMOKE_HOST_LOGIN/PASSWORD, else the dev stack's root .env. */
function hostCredentials() {
  if (process.env.SMOKE_HOST_LOGIN && process.env.SMOKE_HOST_PASSWORD) {
    return { login: process.env.SMOKE_HOST_LOGIN, password: process.env.SMOKE_HOST_PASSWORD };
  }
  const text = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  const env = Object.fromEntries(text.split(/\r?\n/)
    .map((line) => /^([A-Z_]+)=(.*)$/.exec(line)).filter(Boolean).map((match) => [match[1], match[2]]));
  return { login: env.ADMIN_LOGIN, password: env.ADMIN_PASSWORD };
}

/**
 * Log into Studio and press "join" through the API: returns the host's room slug and the
 * meeting path with its single-use `#host=` pass, as the Studio button would open.
 */
async function studioHostLink() {
  const api = await request.newContext({ baseURL: process.env.SMOKE_API_BASE || "http://localhost:3001", extraHTTPHeaders: { origin: "http://localhost:3000" } });
  try {
    const login = await api.post("/api/auth/login", { data: hostCredentials() });
    expect(login.ok(), "Studio login").toBeTruthy();
    const join = await api.post("/api/studio/conference/join", { data: {} });
    expect(join.ok(), "Studio join").toBeTruthy();
    const url = new URL((await join.json()).join_url);
    return { room: decodeURIComponent(url.pathname.split("/").pop()), path: `${url.pathname}${url.hash}` };
  } finally {
    await api.dispose();
  }
}

/** Open one participant in its own browser context and collect console errors. */
async function openParticipant(browser, name, path) {
  const context = await browser.newContext();
  // Deterministic screen video exercises the real producer/consumer path without an OS picker.
  await context.addInitScript(() => {
    /** Capture an animated canvas as the smoke test's screen source. */
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const paint = canvas.getContext("2d");
      let frame = 0;
      const timer = setInterval(() => {
        paint.fillStyle = frame++ % 2 ? "#8844cc" : "#44cc88";
        paint.fillRect(0, 0, canvas.width, canvas.height);
      }, 50);
      const stream = canvas.captureStream(20);
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      /** Release the synthetic source when the meeting stops sharing. */
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !IGNORED_CONSOLE.some((re) => re.test(message.text()))) {
      errors.push(`${name}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`${name} pageerror: ${error.message}`));
  const driver = nextDriver(page);
  await page.goto(path || driver.path(ROOM));
  await driver.join(name, { video: true });
  return { context, page, driver, errors };
}

/** Participant card for a display name on the React media surface. */
function card(page, name) {
  return page
    .getByRole("region", { name: "Участники встречи" })
    .locator("article")
    .filter({ has: page.locator("footer strong", { hasText: new RegExp(`^${name}$`) }) });
}

test("two participants: media, chat and leave", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-4);
  const nameA = `SmokeA${suffix}`;
  const nameB = `SmokeB${suffix}`;
  const a = await openParticipant(browser, nameA);
  const musicMenu = a.page.locator('article[data-card-key="bodrik-music"]').getByRole("button", { name: "Действия", exact: true });
  await a.page.locator('article[data-card-key="bodrik-music"]').hover();
  await musicMenu.click();
  await expect(a.page.getByRole("menu", { name: "Действия", exact: true })).toBeVisible();
  const b = await openParticipant(browser, nameB);

  try {
    await test.step("both see each other and the music participant", async () => {
      await expect(card(a.page, nameB)).toBeVisible();
      await expect(a.page.getByRole("menu", { name: "Действия", exact: true })).toHaveCount(0);
      await expect(card(b.page, nameA)).toBeVisible();
      await expect(a.page.locator('article[data-participant-id="bodrik-music"]')).toHaveCount(1);
      await expect(card(a.page, nameB).locator("video")).toHaveCount(1);
      await expect.poll(() => card(a.page, nameB).locator("video").evaluate((video) =>
        video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0
      ), { message: "remote participant receives decoded video frames" }).toBe(true);
    });

    await test.step("participants visibility follows card actions and dock reopening", async () => {
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

    await test.step("microphone mute is visible to the other participant", async () => {
      await b.driver.toggleMicrophone();
      await expect(card(a.page, nameB).getByRole("img", { name: "Микрофон выключен" })).toBeVisible();
      await b.driver.toggleMicrophone();
      await expect(card(a.page, nameB).getByRole("img", { name: "Микрофон включён" })).toBeVisible();
    });

    await test.step("camera off is visible to the other participant", async () => {
      await b.driver.toggleCamera();
      await expect(card(a.page, nameB).locator("video")).toHaveCount(0);
      await expect(card(a.page, nameB).getByRole("button", { name: "Во весь экран", exact: true })).toHaveCount(0);
      await b.driver.toggleCamera();
      await expect(card(a.page, nameB).locator("video")).toHaveCount(1);
    });

    await test.step("screen video is decoded remotely and removed on stop", async () => {
      const controls = b.page.getByRole("navigation", { name: "Управление встречей" });
      await controls.getByRole("button", { name: "Демонстрация экрана", exact: true }).click();
      await expect(card(a.page, nameB)).toHaveCount(2);
      await expect.poll(() => card(a.page, nameB).locator("video").evaluateAll((videos) =>
        videos.length === 2 && videos.every((video) => video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0)
      ), { message: "remote camera and synthetic screen decode independently" }).toBe(true);
      await expect(card(a.page, nameB).getByRole("button", { name: "Во весь экран", exact: true })).toHaveCount(2);
      await checkStableFocus(a.page);
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

    await test.step("chat works both ways", async () => {
      await a.driver.openChat();
      await b.driver.openChat();
      for (const [from, to, text] of [[a, b, `hello from A ${suffix}`], [b, a, `hello from B ${suffix}`]]) {
        await from.page.getByRole("textbox", { name: "Сообщение" }).fill(text);
        await from.page.getByRole("button", { name: "Отправить" }).click();
        await expect(to.page.getByRole("list", { name: "Сообщения" }).getByText(text)).toBeVisible();
      }
    });

    await test.step("leaving removes the card for the other participant", async () => {
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

    const errors = [...a.errors, ...b.errors];
    if (errors.length) console.log(["Console errors:", ...errors].join("\n"));
    expect(errors, "console errors").toEqual([]);
  } finally {
    await leaveAll(a, b);
    await a.context.close();
    await b.context.close();
  }
});

/**
 * Leave explicitly before closing: closing a page only drops the socket, and the server
 * keeps that session for its grace period, which would leak into the next test.
 */
async function leaveAll(...participants) {
  for (const { page, driver } of participants) {
    for (const current of page.context().pages()) {
      if (await current.locator("main[data-meeting-status=admitted]").count()) {
        await (current === page ? driver : nextDriver(current)).leave().catch(() => {});
        await current.locator("main[data-meeting-status=admitted]").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      }
    }
  }
}

/** Open a participant card's action menu and choose one item. */
async function cardAction(page, name, item) {
  const target = card(page, name);
  await target.hover();
  await target.getByRole("button", { name: "Действия" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("presenter kicks and bans; the ban list lifts the ban", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-4);
  const nameA = `HostA${suffix}`;
  const nameB = `GuestB${suffix}`;
  const host = await studioHostLink();
  const a = await openParticipant(browser, nameA, host.path);
  const b = await openParticipant(browser, nameB, `/room/${encodeURIComponent(host.room)}`);

  try {
    await test.step("a kicked participant lands on the kicked page and stays out", async () => {
      await expect(card(a.page, nameB)).toBeVisible();
      await cardAction(a.page, nameB, "Выгнать");
      await expect(b.page.getByText("Ведущий завершил ваше участие")).toBeVisible();
      await expect(card(a.page, nameB)).toHaveCount(0);
      // Recovery must not readmit the kicked session.
      await b.page.waitForTimeout(6000);
      await expect(b.page.locator("main[data-meeting-status=admitted]")).toHaveCount(0);
      await expect(card(a.page, nameB)).toHaveCount(0);
    });

    await test.step("a kicked participant may rejoin; a ban blocks rejoining from that browser", async () => {
      await b.page.goto(b.driver.path(host.room));
      await b.driver.join(nameB);
      await expect(card(a.page, nameB)).toBeVisible();
      await cardAction(a.page, nameB, "Забанить на 24 часа");
      // The room's confirmation dialog, not a browser confirm.
      await a.page.getByRole("dialog", { name: "Забанить участника?" }).getByRole("button", { name: "Забанить" }).click();
      await expect(b.page.getByText(/Ведущий заблокировал вам вход/)).toBeVisible();
      await expect(card(a.page, nameB)).toHaveCount(0);
      await b.page.goto(b.driver.path(host.room));
      await b.page.getByRole("textbox", { name: "Введите имя" }).fill(nameB);
      await b.page.getByRole("button", { name: "Присоединиться к встрече" }).click();
      await expect(b.page.getByText(/Ведущий заблокировал вам вход/)).toBeVisible();
      await expect(card(a.page, nameB)).toHaveCount(0);
    });

    await test.step("the moderator tab lists the ban and unbans", async () => {
      await a.page.getByRole("navigation", { name: "Управление встречей" }).getByRole("button", { name: "Настройки", exact: true }).click();
      await a.page.getByRole("tab", { name: "Модератор" }).click();
      const row = a.page.getByRole("listitem").filter({ hasText: nameB });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Разбанить" }).click();
      await expect(a.page.getByText("Никто не забанен.")).toBeVisible();
      await a.page.keyboard.press("Escape");
    });

    await test.step("an unbanned participant can join again", async () => {
      await b.page.goto(b.driver.path(host.room));
      await b.driver.join(nameB);
      await expect(card(a.page, nameB)).toBeVisible();
    });

  } finally {
    await leaveAll(a, b);
    await a.context.close();
    await b.context.close();
  }
});

test("refreshing keeps one card and the presenter role", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-4);
  const nameA = `HostR${suffix}`;
  const nameB = `GuestR${suffix}`;
  const host = await studioHostLink();
  const a = await openParticipant(browser, nameA, host.path);
  const b = await openParticipant(browser, nameB, `/room/${encodeURIComponent(host.room)}`);
  const crown = (page, name) => card(page, name).getByRole("img", { name: "Ведущий" });

  try {
    await test.step("the Studio link makes the host", async () => {
      await expect(crown(b.page, nameA)).toBeVisible();
    });

    await test.step("after a refresh there is still one card and the role is kept", async () => {
      await a.page.reload();
      await a.driver.join(nameA);
      await expect(a.page.getByText(/Participant (?:left the meeting|покинул встречу)/)).toHaveCount(0);
      await expect(card(b.page, nameA)).toHaveCount(1);
      await expect(crown(b.page, nameA)).toBeVisible();
      await expect(crown(a.page, nameA)).toBeVisible();
      // The grace-period session must not come back as a duplicate.
      await b.page.waitForTimeout(3000);
      await expect(card(b.page, nameA)).toHaveCount(1);
    });

    await test.step("a second tab takes over and the first shows the replaced page", async () => {
      const page = await a.context.newPage();
      const driver = nextDriver(page);
      await page.goto(driver.path(host.room));
      await driver.join(nameA);
      await expect(a.page.getByText(/в другой вкладке или на другом устройстве/)).toBeVisible();
      await expect(a.page.getByRole("button", { name: "Подключиться здесь" })).toBeVisible();
      await expect(card(b.page, nameA)).toHaveCount(1);
      await expect(crown(b.page, nameA)).toBeVisible();
    });

    await test.step("when the host leaves nobody inherits the role; the host returns by plain link as host", async () => {
      await leaveAll(a);
      await expect(card(b.page, nameA)).toHaveCount(0);
      await expect(crown(b.page, nameB)).toHaveCount(0);
      const page = await a.context.newPage();
      const driver = nextDriver(page);
      await page.goto(driver.path(host.room));
      await driver.join(nameA);
      await expect(crown(b.page, nameA)).toBeVisible();
      await expect(crown(b.page, nameB)).toHaveCount(0);
    });
  } finally {
    await leaveAll(a, b);
    await a.context.close();
    await b.context.close();
  }
});

test("settings: room password, avatar reset and host-only sections", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-4);
  const host = await studioHostLink();
  const a = await openParticipant(browser, `HostS${suffix}`, host.path);
  const b = await openParticipant(browser, `GuestS${suffix}`, `/room/${encodeURIComponent(host.room)}`);
  /** Open settings on one tab. */
  async function openTab(page, tab) {
    await page.getByRole("navigation", { name: "Управление встречей" }).getByRole("button", { name: "Настройки", exact: true }).click();
    await page.getByRole("tab", { name: tab }).click();
  }
  const png = solidPng(64);

  try {
    await test.step("the host can set and remove a room password", async () => {
      await openTab(a.page, "Комната");
      await expect(a.page.getByRole("heading", { name: "Мои настройки комнаты", exact: true })).toHaveCount(0);
      await expect(a.page.getByRole("switch", { name: "Не выключать экран", exact: true })).toHaveCount(0);
      await a.page.getByRole("textbox", { name: "Пароль комнаты" }).fill("secret-pass");
      await a.page.getByRole("button", { name: "Установить пароль" }).click();
      await expect(a.page.getByRole("button", { name: "Удалить пароль" })).toBeVisible();
      const context = await browser.newContext();
      const guest = await context.newPage();
      const driver = nextDriver(guest);
      try {
        await guest.goto(driver.path(host.room));
        await guest.getByRole("textbox", { name: "Введите имя" }).fill(`Password${suffix}`);
        await guest.getByRole("button", { name: "Присоединиться к встрече" }).click();
        await expect(guest.getByRole("heading", { name: "Нужен пароль" })).toBeVisible();
        await expect(guest.getByRole("link", { name: "На главную Бодрик FM" })).toBeVisible();
        await guest.getByLabel("Пароль", { exact: true }).fill("wrong-pass");
        await guest.getByRole("button", { name: "Войти", exact: true }).click();
        await expect(guest.getByText("Пароль не подошёл. Попробуйте ещё раз.", { exact: true })).toBeVisible();
        await guest.getByLabel("Пароль", { exact: true }).fill("secret-pass");
        await guest.getByRole("button", { name: "Войти", exact: true }).click();
        await expect(guest.locator("main[data-meeting-status=admitted]")).toBeVisible();
        await driver.leave();
      } finally {
        await context.close();
        await a.page.getByRole("button", { name: "Удалить пароль" }).click();
      }

      await expect(a.page.getByRole("textbox", { name: "Пароль комнаты" })).toBeVisible();
    });

    await test.step("the branded lobby waits until the host admits the guest", async () => {
      await a.page.getByRole("switch", { name: "Зал ожидания", exact: true }).click();
      await expect(a.page.getByRole("switch", { name: "Зал ожидания", exact: true })).toBeChecked();
      await a.page.keyboard.press("Escape");
      await a.page.getByRole("navigation", { name: "Управление встречей" }).getByRole("button", { name: "Участники", exact: true }).click();
      const pendingRows = a.page.locator('section[aria-labelledby="meeting-lobby-title"] li');
      const existing = await pendingRows.locator("strong").allTextContents();
      const context = await browser.newContext();
      const guest = await context.newPage();
      const driver = nextDriver(guest);
      try {
        await guest.goto(driver.path(host.room));
        await guest.getByRole("textbox", { name: "Введите имя" }).fill(`Lobby${suffix}`);
        await guest.getByRole("button", { name: "Присоединиться к встрече" }).click();
        await expect(guest.getByRole("heading", { name: "Скоро начнём" })).toBeVisible();
        await expect(guest.getByRole("link", { name: "На главную Бодрик FM" })).toBeVisible();
        await expect.poll(async () => (await pendingRows.locator("strong").allTextContents()).filter(name => !existing.includes(name)).length).toBe(1);
        const [name] = (await pendingRows.locator("strong").allTextContents()).filter(name => !existing.includes(name));
        await pendingRows.filter({ has: a.page.getByText(name, { exact: true }) }).getByRole("button", { name: "Принять", exact: true }).click();
        await expect(guest.locator("main[data-meeting-status=admitted]")).toBeVisible();
        await driver.leave();
      } finally {
        await context.close();
        await a.page.getByRole("button", { name: "Закрыть участников", exact: true }).click();
        await openTab(a.page, "Комната");
        await a.page.getByRole("switch", { name: "Зал ожидания", exact: true }).click();
        await expect(a.page.getByRole("switch", { name: "Зал ожидания", exact: true })).not.toBeChecked();
      }
    });

    await test.step("an uploaded avatar can be reset", async () => {
      await a.page.getByRole("tab", { name: "Профиль" }).click();
      await a.page.getByLabel("Изменить аватар").setInputFiles({ name: "a.png", mimeType: "image/png", buffer: png });
      const reset = a.page.getByRole("button", { name: "Удалить аватар" });
      await expect(reset).toBeVisible();
      await reset.click();
      await expect(reset).toHaveCount(0);
      await expect(a.page.getByText("Не удалось обновить профиль")).toHaveCount(0);
      await a.page.keyboard.press("Escape");
    });

    await test.step("a guest sees no host-only settings", async () => {
      await openTab(b.page, "Комната");
      await expect(b.page.getByText("Доступ к комнате")).toHaveCount(0);
      await expect(b.page.getByRole("textbox", { name: "Пароль комнаты" })).toHaveCount(0);
      await expect(b.page.getByRole("tab", { name: "Модератор" })).toHaveCount(0);
      await b.page.keyboard.press("Escape");
    });
  } finally {
    await a.page.keyboard.press("Escape");
    await b.page.keyboard.press("Escape");
    await leaveAll(a, b);
    await a.context.close();
    await b.context.close();
  }
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
