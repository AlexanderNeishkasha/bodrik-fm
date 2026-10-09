import assert from "node:assert/strict";
import { test } from "node:test";

import { readdirSync } from "node:fs";

import { MEETING_THEMES } from "../features/meeting/client/theme.mjs";
import { buildCards, focusedCard, newScreenKeys } from "../features/meeting/room/gridLayout.mjs";
import { playbackVolume } from "../features/meeting/media/playbackVolume.mjs";

const people = [
  { id: "me", speaking: true, bot: false },
  { id: "bob", speaking: false, bot: false },
  { id: "eve", speaking: true, bot: false },
  { id: "bodrik-music", speaking: false, bot: true },
];
const sources = [
  { id: "a1", participantId: "bob", kind: "audio", paused: false },
  { id: "c1", participantId: "bob", kind: "camera", paused: false },
  { id: "s1", participantId: "bob", kind: "screen", paused: false },
  { id: "s2", participantId: "eve", kind: "screen", paused: true },
];

test("screen shares become separate cards; camera and audio stay on the main card", () => {
  const cards = buildCards(people, sources);
  assert.deepEqual(cards.map((card) => [card.key, card.screen, card.sources.map((source) => source.id)]), [
    ["me", false, []],
    ["bob", false, ["a1", "c1"]],
    ["bob:s1", true, ["s1"]],
    ["eve", false, []],
    ["bodrik-music", false, []],
  ]);
});

test("focus is exactly the chosen card; nothing chosen or gone means the grid", () => {
  const cards = buildCards(people, sources);
  const cases = [
    ["chosen participant", "eve", "eve"],
    ["chosen screen share", "bob:s1", "bob:s1"],
    ["nothing chosen: grid", "", null],
    ["chosen card left: grid", "gone", null],
  ];
  for (const [name, focus, expected] of cases) assert.equal(focusedCard(cards, focus)?.key ?? null, expected, name);
});

test("newly started screen shares are detected for auto-focus", () => {
  const cards = buildCards(people, sources);
  const cases = [
    ["first share", new Set(), ["bob:s1"]],
    ["already seen", new Set(["bob:s1"]), []],
  ];
  for (const [name, seen, expected] of cases) assert.deepEqual(newScreenKeys(seen, cards), expected, name);
});

test("meeting themes are exactly the player's theme files", () => {
  const files = readdirSync(new URL("../app/themes/", import.meta.url)).filter((name) => name.endsWith(".css")).map((name) => name.slice(0, -4)).sort();
  assert.deepEqual([...MEETING_THEMES].sort(), files);
});

test("playback volume combines your slider, master volume and the Studio volume for music", () => {
  const cases = [
    ["default", "bob", {}, 100, 0.2, 1],
    ["per-peer slider", "bob", { bob: 50 }, 100, 0.2, 0.5],
    ["master volume", "bob", { bob: 50 }, 50, 0.2, 0.25],
    ["studio volume applies to music only", "bodrik-music", {}, 100, 0.2, 0.2],
    ["music with slider and master", "bodrik-music", { "bodrik-music": 50 }, 50, 0.8, 0.2],
    ["clamped", "bodrik-music", {}, 100, 3, 1],
  ];
  for (const [name, id, volumes, master, studio, expected] of cases) {
    assert.ok(Math.abs(playbackVolume(id, volumes, master, studio) - expected) < 1e-9, name);
  }
});
