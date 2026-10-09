import test from "node:test";
import assert from "node:assert/strict";
import { tooltipPosition } from "../components/ui/tooltipPosition.mjs";

for (const [name, anchor, size, viewport, expected] of [
  ["below anchor", { left: 100, top: 100, bottom: 120 }, { width: 200, height: 80 }, { left: 0, top: 0, width: 800, height: 600 }, { x: 100, y: 128 }],
  ["flip above bottom edge", { left: 100, top: 550, bottom: 570 }, { width: 200, height: 80 }, { left: 0, top: 0, width: 800, height: 600 }, { x: 100, y: 462 }],
  ["shift from right edge", { left: 750, top: 100, bottom: 120 }, { width: 200, height: 80 }, { left: 0, top: 0, width: 800, height: 600 }, { x: 592, y: 128 }],
  ["phone viewport", { left: 10, top: 700, bottom: 720 }, { width: 280, height: 120 }, { left: 0, top: 0, width: 390, height: 844 }, { x: 10, y: 572 }],
  ["oversized text", { left: 0, top: 0, bottom: 20 }, { width: 600, height: 900 }, { left: 0, top: 0, width: 320, height: 600 }, { x: 8, y: 8 }],
  ["visual viewport offset", { left: 15, top: 10, bottom: 30 }, { width: 200, height: 80 }, { left: 20, top: 40, width: 390, height: 400 }, { x: 28, y: 48 }],
]) {
  test(`tooltip viewport placement: ${name}`, () => {
    const result = tooltipPosition(anchor, size, viewport);
    assert.equal(result.x, expected.x);
    assert.equal(result.y, expected.y);
    assert.ok(result.maxWidth <= viewport.width);
    assert.ok(result.maxHeight <= viewport.height);
  });
}
