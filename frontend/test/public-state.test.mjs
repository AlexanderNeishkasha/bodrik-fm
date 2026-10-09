import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePublicStatePayload } from "../app/lib/publicState.mjs";

test("public snapshots normalize valid fields and media-path fallback", () => {
  const cases = [
    [
      {
        room_slug: " room ",
        current: { media_path: "asset.m4a", filename: "old.mp3" },
        is_playing: true,
        position: 12.5,
        sync_token: 7,
        theme: " mono ",
      },
      {
        roomSlug: "room",
        currentTrack: "asset.m4a",
        isPlaying: true,
        position: 12.5,
        syncToken: 7,
        theme: "mono",
      },
    ],
    [
      { current: { media_path: "", filename: "fallback.mp3" } },
      {
        roomSlug: "",
        currentTrack: "fallback.mp3",
        isPlaying: false,
        position: 0,
        syncToken: 0,
        theme: "",
      },
    ],
  ];
  for (const [payload, expected] of cases) {
    assert.deepEqual(normalizePublicStatePayload(payload), expected);
  }
});

test("public snapshots fail closed on malformed numeric and object fields", () => {
  for (const payload of [
    null,
    { current: "track", is_playing: 1, position: Number.NaN, sync_token: Number.POSITIVE_INFINITY },
    { current: { media_path: 42 }, position: -1, sync_token: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.deepEqual(normalizePublicStatePayload(payload), {
      roomSlug: "",
      currentTrack: null,
      isPlaying: false,
      position: 0,
      syncToken: 0,
      theme: "",
    });
  }
});
