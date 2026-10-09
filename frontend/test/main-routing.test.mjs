import assert from "node:assert/strict";
import { test } from "node:test";
import { detectRoomPath, roomPath } from "../app/lib/mainRouting.mjs";

test("room pathname classification handles roots, rooms, reserved and malformed paths", () => {
  const cases = [
    ["/", { roomSlug: null, invalidPath: false }],
    ["", { roomSlug: null, invalidPath: false }],
    ["/my-room", { roomSlug: "my-room", invalidPath: false }],
    ["/%D0%91%D0%BE%D0%B4%D1%80%D0%B8%D0%BA", { roomSlug: "Бодрик", invalidPath: false }],
    ["/studio", { roomSlug: null, invalidPath: true }],
    ["/meeting-unavailable", { roomSlug: null, invalidPath: true }],
    ["/desktop_releases", { roomSlug: null, invalidPath: true }],
    ["/two/segments", { roomSlug: null, invalidPath: true }],
    ["/%", { roomSlug: null, invalidPath: true }],
    ["/room%2Fother", { roomSlug: null, invalidPath: true }],
  ];
  for (const [pathname, expected] of cases) {
    assert.deepEqual(detectRoomPath(pathname), expected, pathname);
  }
});

test("room paths encode slugs as one root segment", () => {
  const cases = [
    ["my-room", "/my-room"],
    ["room name", "/room%20name"],
    ["Бодрик", "/%D0%91%D0%BE%D0%B4%D1%80%D0%B8%D0%BA"],
  ];
  for (const [slug, expected] of cases) {
    assert.equal(roomPath(slug), expected, slug);
  }
});
