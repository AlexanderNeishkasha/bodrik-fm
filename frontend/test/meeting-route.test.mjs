import assert from "node:assert/strict";
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
