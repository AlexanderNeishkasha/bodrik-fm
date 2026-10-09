import assert from "node:assert/strict";
import { test } from "node:test";
import { joinChoiceForRetry } from "../features/meeting/client/retryChoice.mjs";

for (const [name, paused, camera, expected] of [
  ["muted microphone and camera on", true, true, { audio: false, video: true }],
  ["live microphone and camera off", false, false, { audio: true, video: false }],
]) {
  test(`retry choices: ${name}`, () => {
    const state = { selfId: "me", participants: { me: { name: "Updated", avatar: "/new.png" } }, producers: { mic: { paused }, cam: { paused: false } } };
    const local = new Map([["audio", "mic"], ["screen", "share"], ...(camera ? [["camera", "cam"]] : [])]);
    assert.deepEqual(joinChoiceForRetry(state, { name: "Original", avatar: "" }, { audio: true, video: false }, local),
      { name: "Updated", avatar: "/new.png", ...expected });
  });
}
test("retry before admission retains the chosen profile and pending avatar upload", () => {
  const file = { type: "image/png" };
  assert.deepEqual(joinChoiceForRetry({ selfId: "", participants: {}, producers: {} }, { name: "Name", avatar: "", avatarFile: file }, { audio: false, video: true }, new Map()),
    { name: "Name", avatar: "", avatarFile: file, audio: false, video: true });
});
