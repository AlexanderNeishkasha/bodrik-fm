import { expect, test } from "@playwright/test";

import { nextDriver } from "./meetingDriver.mjs";
import { ROOM, card, cardAction, leaveAll, openParticipant, solidPng } from "./meetingParticipants.mjs";

// Signed in on the player host, the owner opens the meeting subdomain (meet.bodrik.lan, like
// meet.bodrik.fm) by a plain link: the shared session cookie alone makes them host.
test("the signed-in room owner hosts from a plain room link", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-4);
  const crown = (page, name) => card(page, name).getByRole("img", { name: "Ведущий" });
  const meeting = new URL(test.info().project.use.baseURL);
  if (meeting.hostname !== "localhost" && !/^\d+(?:\.\d+){3}$/.test(meeting.hostname)
    && !meeting.hostname.startsWith("meet.")) meeting.hostname = `meet.${meeting.hostname}`;
  meeting.pathname = `/room/${encodeURIComponent(ROOM)}`;
  const joined = [];
  try {
    joined.push(await openParticipant(browser, `Owner${suffix}`, meeting.href, { signedIn: true }));
    joined.push(await openParticipant(browser, `Guest${suffix}`));
    const [owner, guest] = joined;
    await expect(crown(guest.page, `Owner${suffix}`)).toBeVisible();
    await expect(card(owner.page, `Guest${suffix}`)).toBeVisible();
    await expect(crown(owner.page, `Guest${suffix}`)).toHaveCount(0);
  } finally {
    await leaveAll(...joined);
    for (const participant of joined) await participant.context.close();
  }
});

// Each scenario joins the signed-in room owner (host) and a guest once; its steps run as serial tests within the smoke limit.
test.describe.serial("presenter kicks and bans; the ban list lifts the ban", () => {
  const suffix = Date.now().toString(36).slice(-4);
  const nameA = `HostA${suffix}`;
  const nameB = `GuestB${suffix}`;
  let a;
  let b;

  test.beforeAll(async ({ browser }) => {
    a = await openParticipant(browser, nameA, undefined, { signedIn: true });
    b = await openParticipant(browser, nameB);
  });

  test.afterAll(async () => {
    const joined = [a, b].filter(Boolean);
    await leaveAll(...joined);
    for (const participant of joined) await participant.context.close();
  });

  test("a kicked participant lands on the kicked page and stays out", async () => {
    await expect(card(a.page, nameB)).toBeVisible();
    await cardAction(a.page, nameB, "Выгнать");
    await expect(b.page.getByRole("heading", { name: "Ведущий отключил вас от встречи" })).toBeVisible();
    await expect(card(a.page, nameB)).toHaveCount(0);
    // Recovery must not readmit the kicked session: 2 s spans the first reconnect (0.5 s, 1 s) and
    // readmission (1 s) attempts; the full backoff schedule is covered by meeting-client-recovery unit tests.
    await b.page.waitForTimeout(2000);
    await expect(b.page.locator("main[data-meeting-status=admitted]")).toHaveCount(0);
    await expect(card(a.page, nameB)).toHaveCount(0);
  });

  test("a kicked participant may rejoin; a ban blocks rejoining from that browser", async () => {
    await b.page.goto(b.driver.path(ROOM));
    await b.driver.join(nameB);
    await expect(card(a.page, nameB)).toBeVisible();
    await cardAction(a.page, nameB, "Заблокировать на 24 часа");
    // The room's confirmation dialog, not a browser confirm.
    await a.page.getByRole("dialog", { name: "Заблокировать участника?" }).getByRole("button", { name: "Заблокировать" }).click();
    await expect(b.page.getByText(/Ведущий закрыл вам вход/)).toBeVisible();
    await expect(card(a.page, nameB)).toHaveCount(0);
    await b.page.goto(b.driver.path(ROOM));
    await b.driver.fillName(nameB);
    await b.page.getByRole("button", { name: "Присоединиться к встрече" }).click();
    await expect(b.page.getByText(/Ведущий закрыл вам вход/)).toBeVisible();
    await expect(card(a.page, nameB)).toHaveCount(0);
  });

  test("the moderator tab lists the ban and unbans", async () => {
    await a.page.getByRole("navigation", { name: "Управление встречей" }).getByRole("button", { name: "Настройки", exact: true }).click();
    await a.page.getByRole("tab", { name: "Модератор" }).click();
    const row = a.page.getByRole("listitem").filter({ hasText: nameB });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Разблокировать" }).click();
    await expect(a.page.getByText("Никто не заблокирован.")).toBeVisible();
    await a.page.keyboard.press("Escape");
  });

  test("an unbanned participant can join again", async () => {
    await b.page.goto(b.driver.path(ROOM));
    await b.driver.join(nameB);
    await expect(card(a.page, nameB)).toBeVisible();
  });
});

test.describe.serial("refreshing keeps one card and the presenter role", () => {
  const suffix = Date.now().toString(36).slice(-4);
  const nameA = `HostR${suffix}`;
  const nameB = `GuestR${suffix}`;
  const crown = (page, name) => card(page, name).getByRole("img", { name: "Ведущий" });
  let a;
  let b;

  test.beforeAll(async ({ browser }) => {
    a = await openParticipant(browser, nameA, undefined, { signedIn: true });
    b = await openParticipant(browser, nameB);
  });

  test.afterAll(async () => {
    const joined = [a, b].filter(Boolean);
    await leaveAll(...joined);
    for (const participant of joined) await participant.context.close();
  });

  test("the signed-in owner is the host", async () => {
    await expect(crown(b.page, nameA)).toBeVisible();
  });

  test("after a refresh there is still one card and the role is kept", async () => {
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

  test("a second tab takes over and the first shows the replaced page", async () => {
    const page = await a.context.newPage();
    const driver = nextDriver(page);
    await page.goto(driver.path(ROOM));
    await driver.join(nameA);
    await expect(a.page.getByText(/в другой вкладке или на другом устройстве/)).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Подключиться здесь" })).toBeVisible();
    await expect(card(b.page, nameA)).toHaveCount(1);
    await expect(crown(b.page, nameA)).toBeVisible();
  });

  test("when the host leaves nobody inherits the role; the owner returns as host", async () => {
    await leaveAll(a);
    await expect(card(b.page, nameA)).toHaveCount(0);
    await expect(crown(b.page, nameB)).toHaveCount(0);
    const page = await a.context.newPage();
    const driver = nextDriver(page);
    await page.goto(driver.path(ROOM));
    await driver.join(nameA);
    await expect(crown(b.page, nameA)).toBeVisible();
    await expect(crown(b.page, nameB)).toHaveCount(0);
  });
});

test.describe.serial("settings: room password, avatar reset and host-only sections", () => {
  const suffix = Date.now().toString(36).slice(-4);
  const png = solidPng(64);
  let a;
  let b;
  /** Open settings on one tab. */
  async function openTab(page, tab) {
    await page.getByRole("navigation", { name: "Управление встречей" }).getByRole("button", { name: "Настройки", exact: true }).click();
    await page.getByRole("tab", { name: tab }).click();
  }

  test.beforeAll(async ({ browser }) => {
    a = await openParticipant(browser, `HostS${suffix}`, undefined, { signedIn: true });
    b = await openParticipant(browser, `GuestS${suffix}`);
  });

  test.afterAll(async () => {
    for (const participant of [a, b].filter(Boolean)) await participant.page.keyboard.press("Escape");
    const joined = [a, b].filter(Boolean);
    await leaveAll(...joined);
    for (const participant of joined) await participant.context.close();
  });

  test("the host can set and remove a room password", async ({ browser }) => {
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
      await guest.goto(driver.path(ROOM));
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

  test("the branded lobby waits until the host admits the guest", async ({ browser }) => {
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
      await guest.goto(driver.path(ROOM));
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

  test("an uploaded avatar can be reset", async () => {
    await a.page.getByRole("tab", { name: "Профиль" }).click();
    await a.page.getByLabel("Сменить аватар").setInputFiles({ name: "a.png", mimeType: "image/png", buffer: png });
    const reset = a.page.getByRole("button", { name: "Удалить аватар" });
    await expect(reset).toBeVisible();
    await reset.click();
    await expect(reset).toHaveCount(0);
    await expect(a.page.getByText("Не удалось обновить профиль")).toHaveCount(0);
    await a.page.keyboard.press("Escape");
  });

  test("a guest sees no host-only settings", async () => {
    await openTab(b.page, "Комната");
    await expect(b.page.getByText("Доступ к комнате")).toHaveCount(0);
    await expect(b.page.getByRole("textbox", { name: "Пароль комнаты" })).toHaveCount(0);
    await expect(b.page.getByRole("tab", { name: "Модератор" })).toHaveCount(0);
    await b.page.keyboard.press("Escape");
  });
});
