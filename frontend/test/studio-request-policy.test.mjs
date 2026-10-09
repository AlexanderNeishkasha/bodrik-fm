import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextDraftRevision,
  normalizeConferenceVolume,
  ownsDraftRevision,
} from "../app/studio/lib/requestPolicy.mjs";

test("Studio draft revisions advance and reject obsolete owners", () => {
  const cases = [
    [undefined, 1],
    [-1, 1],
    [0, 1],
    [7, 8],
  ];
  for (const [current, expected] of cases) {
    assert.equal(nextDraftRevision(current), expected);
    assert.equal(ownsDraftRevision(expected, expected), true);
    assert.equal(ownsDraftRevision(expected + 1, expected), false);
  }
});

test("conference volume accepts finite boundaries and rejects malformed values", () => {
  const cases = [
    [-1, 0],
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [2, 1],
    ["0.25", 0.25],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    ["", null],
    [undefined, null],
  ];
  for (const [value, expected] of cases) {
    assert.equal(normalizeConferenceVolume(value), expected, String(value));
  }
});
