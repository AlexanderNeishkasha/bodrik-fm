import assert from "node:assert/strict";
import { test } from "node:test";
import { themePreference } from "../app/lib/themePreference.mjs";

/** Bounded fixture vocabulary for accepted theme values. */
const themes = ["pirate", "noir", "aurora", "midnight"];

for (const [name, cookie, saved, expected] of [
  ["shared cookie wins over stale local storage", "bodrik_fm_theme_v2=aurora", { bodrik_fm_theme_v2: "midnight" }, "aurora"],
  ["local storage applies without a cookie", "", { bodrik_fm_theme_v2: "midnight" }, "midnight"],
  ["invalid cookie falls back", "bodrik_fm_theme_v2=unknown", { bodrik_fm_theme_v2: "midnight" }, "midnight"],
  ["invalid preferences are ignored", "bodrik_fm_theme_v2=%22script", { bodrik_fm_theme_v2: "unknown" }, null],
  ["current key wins over the legacy key", "bodrik_fm_theme=aurora; bodrik_fm_theme_v2=midnight", {}, "midnight"],
  ["legacy grey mono becomes pirate", "bodrik_fm_theme=mono", {}, "pirate"],
  ["legacy black pirate becomes noir", "", { bodrik_fm_theme: "pirate" }, "noir"],
  ["other legacy themes keep their id", "bodrik_fm_theme=aurora", {}, "aurora"],
]) {
  test(`theme preference read: ${name}`, () => {
    const storage = { getItem: (key) => saved[key] ?? null };
    assert.equal(themePreference("read", null, themes, { document: { cookie }, storage }), expected);
  });
}

for (const [hostname, protocol, domain, secure] of [
  ["bodrik.fm", "https:", true, true],
  ["meet.bodrik.fm", "https:", true, true],
  ["pc.lan", "http:", false, false],
  ["fakebodrik.fm", "https:", false, true],
  ["bodrik.fm.evil.test", "https:", false, true],
]) {
  test(`theme cookie scope: ${hostname}`, () => {
    const document = { cookie: "" };
    const writes = [];
    themePreference("write", "aurora", themes, { document, location: { hostname, protocol }, storage: { setItem: (...args) => writes.push(args) } });
    assert.deepEqual(writes, [["bodrik_fm_theme_v2", "aurora"]]);
    assert.match(document.cookie, /Path=\/; Max-Age=31536000; SameSite=Lax/);
    assert.equal(document.cookie.includes("Domain=bodrik.fm"), domain);
    assert.equal(document.cookie.includes("Secure"), secure);
    const previous = document.cookie;
    assert.equal(themePreference("write", "unknown", themes, { document }), null);
    assert.equal(document.cookie, previous);
  });
}

test("blocked storage still permits the shared cookie; blocked cookie still permits storage", () => {
  const document = { cookie: "bodrik_fm_theme_v2=aurora" };
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(themePreference("read", null, themes, { document, storage }), "aurora");
  themePreference("write", "midnight", themes, { document, storage });
  assert.match(document.cookie, /bodrik_fm_theme_v2=midnight/);
  const blocked = { get cookie() { throw new Error("blocked"); }, set cookie(_value) { throw new Error("blocked"); } };
  assert.equal(themePreference("read", null, themes, { document: blocked, storage: { getItem: () => "aurora" } }), "aurora");
});

test("unchanged snapshots do not rewrite cookies or local storage", () => {
  const document = { get cookie() { return "bodrik_fm_theme_v2=aurora"; }, set cookie(_value) { assert.fail("redundant cookie write"); } };
  const storage = { getItem: () => "aurora", setItem() { assert.fail("redundant storage write"); } };
  assert.equal(themePreference("write", "aurora", themes, { document, storage }), "aurora");
});
