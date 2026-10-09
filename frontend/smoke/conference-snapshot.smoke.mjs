import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

let fixture;
test.use({ permissions: [] });
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import useConference from "./app/studio/hooks/useConference.js";
      /** Exercise the real hook against intercepted, non-mutating authority responses. */
      function Probe() {
        const [room, setRoom] = useState({ conference_allowed: true, conference_enabled: false });
        const [owner, setOwner] = useState(1);
        const conference = useConference({ apiBase: "http://conference-hook.test", asUserId: owner,
          isAuthed: true, roomState: room, showNotice: value => window.notices.push(value) });
        window.updateConferenceRoom = setRoom;
        window.switchConferenceOwner = () => { setRoom({}); setOwner(2); };
        return <><pre data-testid="snapshot" data-room-enabled={String(room.conference_enabled)}>{JSON.stringify({ allowed: conference.allowed,
          enabled: conference.enabled, inviteUrl: conference.inviteUrl })}</pre>
          <button onClick={() => conference.setEnabled(true)}>Enable</button></>;
      }
      window.notices = [];
      createRoot(document.getElementById("root")).render(<Probe />);
    `, resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "jsx" },
    bundle: true, platform: "browser", format: "iife", write: false, jsx: "automatic",
    loader: { ".js": "jsx" }, define: { "process.env.NODE_ENV": '"development"' },
  });
  fixture = `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script>${result.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`;
});

/** Read the actual rendered public hook snapshot, not cached test state. */
async function snapshot(page) {
  return JSON.parse(await page.getByTestId("snapshot").textContent());
}

test("confirmed command responses survive unchanged room fields; new stream observations still win", async ({ page }) => {
  await page.route("http://conference-hook.test/**", route => route.fulfill({ json: {
    allowed: true, enabled: route.request().method() === "POST", invite_url: "/room/owner-one",
  } }));
  await page.setContent(fixture);
  await expect.poll(() => snapshot(page)).toEqual({ allowed: true, enabled: false, inviteUrl: "/room/owner-one" });
  await page.getByRole("button", { name: "Enable" }).click();
  await expect.poll(() => snapshot(page)).toEqual({ allowed: true, enabled: true, inviteUrl: "/room/owner-one" });
  await page.evaluate(() => window.updateConferenceRoom({ conference_allowed: true, conference_enabled: true }));
  await expect(page.getByTestId("snapshot")).toHaveAttribute("data-room-enabled", "true");
  await page.evaluate(() => window.updateConferenceRoom({ conference_allowed: true, conference_enabled: false }));
  await expect.poll(() => snapshot(page)).toEqual({ allowed: true, enabled: false, inviteUrl: "/room/owner-one" });
  await page.evaluate(() => window.updateConferenceRoom({ conference_allowed: false, conference_enabled: false }));
  await expect.poll(() => snapshot(page)).toEqual({ allowed: false, enabled: false, inviteUrl: "/room/owner-one" });
  expect(await page.evaluate(() => window.notices)).toEqual([]);
});

test("identity switches clear invitation/flags before the next scoped response arrives", async ({ page }) => {
  let release;
  let waiting = false;
  const responseGate = new Promise(resolve => { release = resolve; });
  await page.route("http://conference-hook.test/**", async route => {
    const owner = route.request().headers()["x-studio-as-user-id"];
    if (owner === "2") { waiting = true; await responseGate; }
    await route.fulfill({ json: { allowed: true, enabled: false, invite_url: `/room/owner-${owner}` } });
  });
  try {
    await page.setContent(fixture);
    await expect.poll(() => snapshot(page)).toEqual({ allowed: true, enabled: false, inviteUrl: "/room/owner-1" });
    await page.evaluate(() => window.switchConferenceOwner());
    await expect.poll(() => waiting).toBe(true);
    expect(await snapshot(page)).toEqual({ allowed: false, enabled: false, inviteUrl: null });
    release();
    await expect.poll(() => snapshot(page)).toEqual({ allowed: true, enabled: false, inviteUrl: "/room/owner-2" });
  } finally {
    release();
  }
});
