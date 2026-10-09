import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveMeetingInvitation } from "../features/meeting/runtime/meetingAdmission.mjs";

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("enabled canonical invitation reaches prejoin without starting a runtime", async () => {
  const calls = [];
  const result = await resolveMeetingInvitation({
    slug: "table-7",
    fetchImpl: async (...args) => { calls.push(args); return response(200, { enabled: true }); },
  });
  assert.deepEqual(result, { phase: "prejoin", code: null, slug: "table-7" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls[0][0], "/api/rooms/table-7/conference");
  assert.equal(calls[0][1].cache, "no-store");
});

test("disabled missing revoked malformed and rate-limited invitations fail closed", async () => {
  const cases = [
    ["disabled", 200, { enabled: false }, "disabled"],
    ["missing", 404, {}, "unavailable"],
    ["revoked", 410, {}, "revoked"],
    ["limited", 429, {}, "rate_limited"],
    ["server-unavailable", 503, {}, "network"],
  ];
  for (const [slug, status, body, code] of cases) {
    assert.deepEqual(await resolveMeetingInvitation({
      slug,
      fetchImpl: async () => response(status, body),
    }), { phase: "error", code, slug: null }, slug);
  }
  let called = false;
  assert.deepEqual(await resolveMeetingInvitation({
    slug: "bad path",
    fetchImpl: async () => { called = true; return response(200, { enabled: true }); },
  }), { phase: "error", code: "malformed", slug: null });
  assert.equal(called, false);
});

test("admission cancellation propagates while ordinary network failures stay bounded", async () => {
  await assert.rejects(resolveMeetingInvitation({
    slug: "table",
    fetchImpl: async () => { throw new DOMException("obsolete", "AbortError"); },
  }), { name: "AbortError" });
  assert.deepEqual(await resolveMeetingInvitation({
    slug: "table",
    fetchImpl: async () => { throw new Error("private transport details"); },
  }), { phase: "error", code: "network", slug: null });
});
