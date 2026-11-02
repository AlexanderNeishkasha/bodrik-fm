/** Shared participants, Studio host links and cleanup for the multi-participant meeting smokes. */
import { deflateSync } from "node:zlib";

import { expect, test } from "@playwright/test";

import { nextDriver } from "./meetingDriver.mjs";
import { smokeAccount, smokeRoom } from "./smokeRooms.mjs";

export const ROOM = smokeRoom();

/** Console errors that are known noise from fake devices, not regressions. */
const IGNORED_CONSOLE = [/Microphone meter initialization failed/];

/** A valid solid-color square PNG (RGB, 8-bit) for avatar uploads. */
export function solidPng(size) {
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

/**
 * Open one participant in its own browser context and collect console errors. `signedIn`
 * logs the context into Studio as this worker's room owner first, on the player host (baseURL).
 */
export async function openParticipant(browser, name, path, { signedIn = false } = {}) {
  const context = await browser.newContext();
  if (signedIn) {
    const origin = new URL(test.info().project.use.baseURL).origin;
    const login = await context.request.post("/api/auth/login", { data: smokeAccount(), headers: { origin } });
    expect(login.ok(), "owner login").toBeTruthy();
  }
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
export function card(page, name) {
  return page
    .getByRole("region", { name: "Участники встречи" })
    .locator("article")
    .filter({ has: page.locator("footer strong", { hasText: new RegExp(`^${name}$`) }) });
}

/**
 * Leave explicitly before closing: closing a page only drops the socket, and the server
 * keeps that session for its grace period, which would leak into the next test.
 */
export async function leaveAll(...participants) {
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
export async function cardAction(page, name, item) {
  const target = card(page, name);
  await target.hover();
  await target.getByRole("button", { name: "Действия" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}
