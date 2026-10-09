import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAvatar } from "../features/meeting/client/avatarImage.mjs";

/** Fake canvas recording the draw call and producing a WebP blob. */
function fakeCanvas(calls, blob = new Blob(["x"], { type: "image/webp" })) {
  return {
    getContext: () => ({ drawImage: (...args) => calls.push(args) }),
    toBlob: (done, type, quality) => { calls.push([type, quality]); done(blob); },
  };
}

const cases = [
  { name: "landscape crops the center square", width: 1200, height: 800, source: [200, 0, 800, 800] },
  { name: "portrait crops the center square", width: 600, height: 1000, source: [0, 200, 600, 600] },
];

for (const item of cases) {
  test(`normalizeAvatar: ${item.name}`, async () => {
    const calls = [];
    let closed = false;
    const blob = await normalizeAvatar({}, {
      createBitmap: async () => ({ width: item.width, height: item.height, close: () => { closed = true; } }),
      createCanvas: () => fakeCanvas(calls),
    });
    assert.equal(blob.type, "image/webp");
    assert.deepEqual(calls[0].slice(1), [...item.source, 0, 0, 256, 256]);
    assert.deepEqual(calls[1], ["image/webp", 0.82]);
    assert.equal(closed, true);
  });
}

test("normalizeAvatar: rejects when encoding fails", async () => {
  const canvas = { getContext: () => ({ drawImage() {} }), toBlob: (done) => done(null) };
  await assert.rejects(normalizeAvatar({}, { createBitmap: async () => ({ width: 10, height: 10 }), createCanvas: () => canvas }), /conversion failed/);
});
