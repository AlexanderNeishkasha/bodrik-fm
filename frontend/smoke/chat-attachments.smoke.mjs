import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";
import { smokeRoom } from "./smokeRooms.mjs";

/** Join an isolated participant with chat visible. */
async function participant(browser, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const driver = nextDriver(page);
  await page.goto(driver.path(smokeRoom()));
  await driver.join(name);
  await driver.openChat();
  const chat = page.getByRole("complementary", { name: "Чат", exact: true });
  await expect(chat).toBeVisible();
  return { context, page, chat, driver, name };
}

/** Send a selected attachment through the actual chat composer. */
async function attach(person, name, buffer, mimeType = "application/pdf", drop = false) {
  if (drop) {
    const dataTransfer = await person.page.evaluateHandle(({ name, bytes, mimeType }) => {
      const value = new DataTransfer();
      value.items.add(new File([new Uint8Array(bytes)], name, { type: mimeType }));
      return value;
    }, { name, bytes: [...buffer], mimeType });
    try {
      const zone = person.chat.locator("[data-chat-drop-zone]");
      const textarea = person.chat.getByRole("textbox", { name: "Сообщение", exact: true });
      await zone.dispatchEvent("dragenter", { dataTransfer });
      const hint = person.chat.getByText("Перетащите сюда файл или изображение", { exact: true });
      await expect(hint).toBeVisible();
      await textarea.dispatchEvent("dragenter", { dataTransfer });
      await textarea.dispatchEvent("dragleave", { dataTransfer });
      await expect(hint).toBeVisible();
      await zone.dispatchEvent("dragover", { dataTransfer });
      await textarea.dispatchEvent("drop", { dataTransfer });
      await expect(hint).toHaveCount(0);
      await expect(person.chat.getByRole("button", { name: "Убрать вложение", exact: true })).toBeVisible();
      await expect(person.chat.locator("[data-chat-file]").filter({ hasText: name })).toHaveCount(0);
    } finally { await dataTransfer.dispose(); }
  } else {
    await person.chat.locator("[data-chat-attachment-picker]").setInputFiles({ name, buffer, mimeType });
  }
  await person.chat.getByRole("button", { name: "Отправить", exact: true }).click();
}

/** Select a private conversation using its current session identity. */
async function conversation(person, name) {
  const selector = person.chat.getByRole("combobox", { name: "Беседа" });
  const id = await selector.locator("option").filter({ hasText: name }).getAttribute("value");
  await selector.selectOption(id);
}

/** Download a verified document and compare its original bytes. */
async function download(person, name, bytes) {
  const waiting = person.page.waitForEvent("download");
  await person.chat.getByRole("button", { name: `Скачать: ${name}`, exact: true }).click();
  const result = await waiting;
  expect(result.suggestedFilename()).toBe(name);
  expect(await readFile(await result.path())).toEqual(bytes);
}

/** Leave and close every joined participant, newest first. */
async function leaveEveryone(people) {
  for (const person of people.reverse()) {
    await person.page.bringToFront().catch(() => {});
    await person.driver.leave().catch(() => {});
    await person.context.close();
  }
}

// One room of three participants; each step is a serial test so it keeps the short smoke limit.
test.describe.serial("chat sends images and downloadable public/private documents without a separate Files form", () => {
  const suffix = Date.now().toString(36).slice(-5);
  const rules = `Правила-${suffix}.pdf`;
  const publicBytes = Buffer.from("Meeting public rules\n".repeat(4000));
  const people = [];
  let a;
  let b;
  let c;

  test.beforeAll(async ({ browser }) => {
    a = await participant(browser, `AttachA${suffix}`); people.push(a);
    b = await participant(browser, `AttachB${suffix}`); people.push(b);
    c = await participant(browser, `AttachC${suffix}`); people.push(c);
  });

  test.afterAll(async () => { await leaveEveryone(people); });

  test("a dropped public document reaches everyone and downloads intact", async () => {
    await attach(a, rules, publicBytes, "application/pdf", true);
    for (const person of people) {
      await expect(person.chat.locator('[data-chat-file][data-transfer-phase="completed"]').filter({ hasText: rules })).toBeVisible();
    }
    await download(b, rules, publicBytes);
    await download(a, rules, publicBytes);
  });

  test("a private document reaches only the selected participant", async () => {
    await conversation(a, b.name);
    const privateBytes = Buffer.from("Only the selected participant receives this document.");
    await attach(a, "Личные заметки.txt", privateBytes, "text/plain");
    await conversation(b, a.name);
    await expect(b.chat.getByRole("button", { name: "Скачать: Личные заметки.txt", exact: true })).toBeEnabled();
    await download(b, "Личные заметки.txt", privateBytes);
    await expect(c.chat.locator("[data-chat-file]").filter({ hasText: "Личные заметки.txt" })).toHaveCount(0);
    await expect(b.chat.locator("[data-chat-file]").filter({ hasText: rules })).toHaveCount(0);
    await b.chat.getByRole("combobox", { name: "Беседа" }).selectOption("all");
    await expect(b.chat.locator("[data-chat-file]").filter({ hasText: rules })).toHaveCount(1);
  });

  test("a document fits a phone-width chat", async () => {
    await b.page.setViewportSize({ width: 390, height: 844 });
    const mobileFile = b.chat.locator("[data-chat-file]").filter({ hasText: rules });
    await expect(mobileFile).toBeVisible();
    const bounds = await mobileFile.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await b.page.screenshot({ path: test.info().outputPath("chat-file-mobile.png") });
  });

  test("a dropped image shows inline instead of as a file", async () => {
    await a.chat.getByRole("combobox", { name: "Беседа" }).selectOption("all");
    const png = Buffer.from(await a.page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
      const paint = canvas.getContext("2d"); paint.fillStyle = "#70cbaa"; paint.fillRect(0, 0, 32, 32);
      return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    await attach(a, `photo-${suffix}.png`, png, "image/png", true);
    await expect(b.chat.getByRole("img", { name: `photo-${suffix}.png`, exact: true })).toBeVisible();
    await expect(b.chat.locator("[data-chat-file]").filter({ hasText: `photo-${suffix}.png` })).toHaveCount(0);
  });
});

test.describe.serial("public chat survives reload and late join; sender deletion removes it globally", () => {
  const suffix = Date.now().toString(36);
  const name = `Постоянный-${suffix}.txt`;
  const bytes = Buffer.from(`persistent ${suffix}`);
  const imageName = `saved-${suffix}.png`;
  const people = [];
  let a;
  let b;

  test.beforeAll(async ({ browser }) => {
    a = await participant(browser, `PersistA${suffix}`); people.push(a);
  });

  test.afterAll(async () => { await leaveEveryone(people); });

  test("a sent document survives a sender reload", async () => {
    await attach(a, name, bytes, "text/plain");
    await expect(a.chat.getByRole("button", { name: `Скачать: ${name}`, exact: true })).toBeVisible();
    await a.page.reload();
    await a.driver.join(`PersistA${suffix}`);
    await a.driver.openChat();
    await download(a, name, bytes);
  });

  test("a late joiner downloads the earlier document", async ({ browser }) => {
    b = await participant(browser, `PersistB${suffix}`); people.push(b);
    await download(b, name, bytes);
  });

  test("an image preview survives a receiver reload", async () => {
    const image = Buffer.from(await a.page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
      return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    await attach(a, imageName, image, "image/png");
    await expect(b.chat.getByRole("img", { name: imageName, exact: true })).toBeVisible();
    await b.page.reload(); await b.driver.join(`PersistB${suffix}`); await b.driver.openChat();
    const preview = b.chat.getByRole("img", { name: imageName, exact: true });
    await expect(preview).toBeVisible();
    expect(await preview.evaluate((img) => img.complete && img.naturalWidth === 8)).toBe(true);
  });

  test("stored attachments are not publicly readable", async ({ request }) => {
    expect((await request.get("/_chat_attachments/anything.bin")).status()).toBe(404);
    expect((await request.get("/api/meeting/chat-attachments/00000000-0000-0000-0000-000000000000")).status()).toBe(401);
  });

  test("sender deletion removes the document for everyone, also after reload", async () => {
    const row = a.chat.getByRole("listitem").filter({ hasText: name });
    await row.hover();
    await row.getByRole("button", { name: "Действия с сообщением", exact: true }).click();
    await row.getByRole("menuitem", { name: "Удалить", exact: true }).click();
    for (const person of [a, b]) await expect(person.chat.getByRole("button", { name: `Скачать: ${name}`, exact: true })).toHaveCount(0);
    await b.page.reload(); await b.driver.join(`PersistB${suffix}`); await b.driver.openChat();
    await expect(b.chat.getByRole("button", { name: `Скачать: ${name}`, exact: true })).toHaveCount(0);
    for (const person of [b, a]) {
      await person.page.bringToFront();
      await person.chat.getByRole("button", { name: "Закрыть чат", exact: true }).click();
      await expect(person.chat).toBeHidden();
    }
  });
});
