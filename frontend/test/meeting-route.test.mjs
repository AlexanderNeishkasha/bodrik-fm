import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  parseMeetingPath,
} from "../features/meeting/runtime/meetingRoute.mjs";

test("valid meeting invitations preserve the public pathname and select one fixed export", () => {
  for (const pathname of ["/room/table-7", "/room/ABC_123", "/room/a"]) {
    const result = parseMeetingPath(pathname);
    assert.equal(result.valid, true, pathname);
    assert.equal(`/room/${encodeURIComponent(result.slug)}`, pathname);
  }
});

test("meeting invitation parsing rejects reserved malformed and multi-segment paths", () => {
  for (const pathname of [
    "/room",
    "/room/",
    "/room/api",
    "/room/ws",
    "/room/table/extra",
    "/room/%2Fescape",
    "/room/%ZZ",
    "/room/has space",
    `/room/${"a".repeat(129)}`,
  ]) {
    assert.deepEqual(parseMeetingPath(pathname), { slug: null, valid: false }, pathname);
  }
});

test("meeting entry runs the headless-client session, with no retained document", () => {
  const app = readFileSync(new URL("../features/meeting/MeetingApp.js", import.meta.url), "utf8");
  assert.match(app, /<MeetingSession slug=\{admission\.slug\} \/>/);
  assert.doesNotMatch(app, /iframe|retained-meeting|LegacyMeetingFrame/);
});

test("fixed meeting page keeps browser work behind an explicit client boundary", () => {
  const page = readFileSync(new URL("../app/meeting/page.js", import.meta.url), "utf8");
  const boundary = readFileSync(new URL("../features/meeting/MeetingClientBoundary.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../features/meeting/MeetingApp.js", import.meta.url), "utf8");
  assert.doesNotMatch(page, /window|document|localStorage|WebSocket|getUserMedia|mediasoup/i);
  assert.match(boundary, /^"use client";/);
  assert.match(boundary, /import MeetingApp from "\.\/MeetingApp";/);
  assert.match(app, /typeof window === "undefined" \? "\/meeting" : window\.location\.pathname/);
  assert.doesNotMatch(app, /localStorage|WebSocket|getUserMedia|mediasoup/i);
});
