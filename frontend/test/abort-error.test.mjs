import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbortError } from "../app/lib/abortError.mjs";

test("abort errors stay distinct from operational failures", () => {
  const cases = [
    ["plain abort object", { name: "AbortError" }, true],
    ["DOMException abort", new DOMException("cancelled", "AbortError"), true],
    ["operational error", new Error("offline"), false],
    ["timeout DOMException", new DOMException("slow", "TimeoutError"), false],
    ["null", null, false],
    ["undefined", undefined, false],
  ];
  for (const [name, error, expected] of cases) {
    assert.equal(isAbortError(error), expected, name);
  }
});
