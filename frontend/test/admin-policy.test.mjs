import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAbortError,
  nextRequestRevision,
  ownsRequestRevision,
  passwordResetPayload,
  updateAdminUser,
} from "../app/puppet_master/lib/adminPolicy.mjs";

test("admin draft revisions advance and reject obsolete responses", () => {
  const cases = [
    [null, 1],
    [{ revision: 1 }, 2],
    [{ revision: 7 }, 8],
  ];
  for (const [previous, expected] of cases) {
    assert.equal(nextRequestRevision(previous), expected);
    assert.equal(ownsRequestRevision({ revision: expected }, expected), true);
    assert.equal(ownsRequestRevision({ revision: expected + 1 }, expected), false);
  }
});

test("admin password payload preserves meaningful whitespace", () => {
  const cases = [
    ["", null],
    [" secret ", { password: " secret " }],
    ["   ", { password: "   " }],
  ];
  for (const [password, expected] of cases) {
    assert.deepEqual(passwordResetPayload(password), expected);
  }
});

test("admin row updates affect only the selected user", () => {
  const rows = [
    { id: 1, login: "one", room_slug: "first" },
    { id: 2, login: "two", room_slug: "second" },
  ];
  assert.deepEqual(updateAdminUser(rows, 2, { room_slug: "changed" }), [
    rows[0],
    { id: 2, login: "two", room_slug: "changed" },
  ]);
  assert.deepEqual(updateAdminUser(rows, 3, { room_slug: "missing" }), rows);
});

test("abort errors stay distinct from operational failures", () => {
  assert.equal(isAbortError({ name: "AbortError" }), true);
  assert.equal(isAbortError(new Error("offline")), false);
  assert.equal(isAbortError(null), false);
});
