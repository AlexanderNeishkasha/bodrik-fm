import assert from "node:assert/strict";
import { test } from "node:test";
import { themePreference } from "../app/lib/themePreference.mjs";

/** Bounded fixture vocabulary for accepted theme values. */
const themes = ["mono", "aurora", "midnight"];

for (const [name, cookie, saved, expected] of [
  ["shared cookie wins over stale local storage", "bodrik_fm_theme=aurora", "midnight", "aurora"],
  ["legacy storage migrates", "", "midnight", "midnight"],
  ["invalid cookie falls back", "bodrik_fm_theme=unknown", "midnight", "midnight"],
  ["invalid preferences are ignored", "bodrik_fm_theme=%22script", "unknown", null],
]) {
  test(`theme preference read: ${name}`, () => {
    assert.equal(themePreference("read", null, themes, { document: { cookie }, storage: { getItem: () => saved } }), expected);
  });
}

for (const [hostname, protocol, domain, secure] of [
  ["bodrik.fm", "https:", true, true],
  ["meet.bodrik.fm", "https:", true, true],
  ["pc.local", "http:", false, false],
  ["fakebodrik.fm", "https:", false, true],
  ["bodrik.fm.evil.test", "https:", false, true],
]) {
  test(`theme cookie scope: ${hostname}`, () => {
    const document = { cookie: "" };
    const writes = [];
    themePreference("write", "aurora", themes, { document, location: { hostname, protocol }, storage: { setItem: (...args) => writes.push(args) } });
    assert.deepEqual(writes, [["bodrik_fm_theme", "aurora"]]);
    assert.match(document.cookie, /Path=\/; Max-Age=31536000; SameSite=Lax/);
    assert.equal(document.cookie.includes("Domain=bodrik.fm"), domain);
    assert.equal(document.cookie.includes("Secure"), secure);
    const previous = document.cookie;
    assert.equal(themePreference("write", "unknown", themes, { document }), null);
    assert.equal(document.cookie, previous);
  });
}

test("blocked storage still permits the shared cookie; blocked cookie still permits storage", () => {
  const document = { cookie: "bodrik_fm_theme=aurora" };
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(themePreference("read", null, themes, { document, storage }), "aurora");
  themePreference("write", "midnight", themes, { document, storage });
  assert.match(document.cookie, /bodrik_fm_theme=midnight/);
  const blocked = { get cookie() { throw new Error("blocked"); }, set cookie(_value) { throw new Error("blocked"); } };
  assert.equal(themePreference("read", null, themes, { document: blocked, storage: { getItem: () => "aurora" } }), "aurora");
});

test("unchanged snapshots do not rewrite cookies or local storage", () => {
  const document = { get cookie() { return "bodrik_fm_theme=aurora"; }, set cookie(_value) { assert.fail("redundant cookie write"); } };
  const storage = { getItem: () => "aurora", setItem() { assert.fail("redundant storage write"); } };
  assert.equal(themePreference("write", "aurora", themes, { document, storage }), "aurora");
});
