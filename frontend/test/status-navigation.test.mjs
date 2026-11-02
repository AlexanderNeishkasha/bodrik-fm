import assert from "node:assert/strict";
import { test } from "node:test";
import { playerOrigin, statusPageHref } from "../app/lib/statusNavigation.mjs";

for (const [name, href, origin, expected] of [
  ["meeting exit returns to player", "/", "https://bodrik.fm", "https://bodrik.fm/"],
  ["error page Studio link returns to player", "/studio", "https://bodrik.fm", "https://bodrik.fm/studio"],
  ["local development keeps relative home", "/", "", "/"],
  ["local development keeps relative Studio", "/studio", "", "/studio"],
  ["rejoin stays on meeting host", "/room/table-7", "https://bodrik.fm", "/room/table-7"],
  ["external links remain unchanged", "https://example.com/", "https://bodrik.fm", "https://example.com/"],
  ["button actions have no destination", undefined, "https://bodrik.fm", undefined],
]) {
  test(name, () => assert.equal(statusPageHref(href, origin), expected));
}

for (const [name, location, production, expected] of [
  ["production always targets bodrik.fm", { protocol: "https:", hostname: "meet.bodrik.fm", host: "meet.bodrik.fm" }, true, "https://bodrik.fm"],
  ["development meeting host returns to the player host", { protocol: "https:", hostname: "meet.pc.lan", host: "meet.pc.lan:3443" }, false, "https://pc.lan:3443"],
  ["development player host stays relative", { protocol: "https:", hostname: "pc.lan", host: "pc.lan:3443" }, false, ""],
  ["server rendering has no location", undefined, false, ""],
]) {
  test(name, () => assert.equal(playerOrigin(location, production), expected));
}
