import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("music participant avatar is a frontend-owned PNG with valid dimensions", () => {
  const owned = readFileSync(new URL("../public/images/bodrik-ava.png", import.meta.url));
  assert.deepEqual([...owned.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  assert.equal(owned.toString("ascii", 12, 16), "IHDR");
  assert.ok(owned.readUInt32BE(16) > 0, "width");
  assert.ok(owned.readUInt32BE(20) > 0, "height");
});
