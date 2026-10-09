import assert from "node:assert/strict";
import { test } from "node:test";

import { createConfirmations } from "../features/meeting/room/confirmations.mjs";

test("confirmations resolve with the answer; a newer request cancels an older one", async () => {
  const store = createConfirmations();
  const first = store.ask({ kind: "ban", name: "Eve" });
  assert.equal(store.getSnapshot().name, "Eve");
  const second = store.ask({ kind: "ban", name: "Bob" });
  assert.equal(await first, false, "superseded request is declined");
  store.answer(true);
  assert.equal(await second, true);
  assert.equal(store.getSnapshot(), null);
  const third = store.ask({ kind: "ban", name: "Max" });
  store.answer(false);
  assert.equal(await third, false);
});
