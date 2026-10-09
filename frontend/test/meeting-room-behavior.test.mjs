import assert from "node:assert/strict";
import test from "node:test";

import { createPreferences, ROOM_BEHAVIOR } from "../features/meeting/client/preferences.mjs";

for (const [name, stored] of [
  ["new browser", null],
  ["old saved flags", JSON.stringify({ sounds: false, shareOnJoin: true, cameraOffParticipants: false, keepControls: false, keepAwake: false })],
]) {
  test(`fixed room behavior: ${name}`, () => {
    const preferences = createPreferences({ storage: { getItem: () => stored } });
    for (const [key, value] of Object.entries(ROOM_BEHAVIOR)) {
      assert.equal(preferences.getSnapshot()[key], value, key);
      assert.throws(() => preferences.set(key, !value), /Invalid preference/, key);
    }
    assert.equal(preferences.getSnapshot().keepAwake, true);
    assert.equal(preferences.getSnapshot().shareOnJoin, false);
  });
}
