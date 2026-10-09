import assert from "node:assert/strict";
import test from "node:test";

import { fitTiles } from "../features/meeting/room/gridLayout.mjs";

const cases = [
  { name: "one tile fills the height-limited area", count: 1, width: 1600, height: 900, columns: 1 },
  { name: "three tiles in a wide area use two columns (2 + 1)", count: 3, width: 1900, height: 950, columns: 2 },
  { name: "three tiles in a very wide strip use one row", count: 3, width: 3000, height: 500, columns: 3 },
  { name: "four tiles use a 2x2 grid", count: 4, width: 1600, height: 900, columns: 2 },
  { name: "tall area stacks tiles", count: 3, width: 400, height: 1200, columns: 1 },
];

for (const item of cases) {
  test(`fitTiles: ${item.name}`, () => {
    const tile = fitTiles(item.count, item.width, item.height);
    assert.equal(tile.columns, item.columns);
    const rows = Math.ceil(item.count / tile.columns);
    assert.ok(tile.width * tile.columns + 12 * (tile.columns - 1) <= item.width);
    assert.ok(tile.height * rows + 12 * (rows - 1) <= item.height);
  });
}

test("fitTiles: empty or unmeasured area yields zero size", () => {
  assert.deepEqual(fitTiles(0, 100, 100), { width: 0, height: 0, columns: 1 });
  assert.deepEqual(fitTiles(3, 0, 0), { width: 0, height: 0, columns: 1 });
});
