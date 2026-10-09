import assert from "node:assert/strict";
import test from "node:test";
import { bindMediaTrack } from "../features/meeting/media/mediaTrackBinding.mjs";

for (const name of ["ordinary cleanup", "repeated cleanup", "replacement before cleanup"]) {
  test(`media track element ownership: ${name}`, () => {
    const track = { stop() { throw new Error("Runtime owns track"); } };
    const element = { srcObject: null };
    const stream = { tracks: [track] };
    const cleanup = bindMediaTrack(element, track, (tracks) => {
      assert.deepEqual(tracks, [track]);
      return stream;
    });
    assert.equal(element.srcObject, stream);
    const replacement = {};
    if (name === "replacement before cleanup") element.srcObject = replacement;
    cleanup();
    if (name === "repeated cleanup") cleanup();
    assert.equal(element.srcObject, name === "replacement before cleanup" ? replacement : null);
  });
}
