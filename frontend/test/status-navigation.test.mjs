import assert from "node:assert/strict";
import { test } from "node:test";
import { statusPageHref } from "../app/lib/statusNavigation.mjs";

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
