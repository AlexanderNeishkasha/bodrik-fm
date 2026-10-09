import assert from "node:assert/strict";
import { test } from "node:test";
import { meetingStatusPage } from "../features/meeting/room/meetingStatusCopy.mjs";

for (const language of ["ru", "en"]) {
  for (const [status, action] of [["idle", "retry"], ["connecting", "retry"], ["left", "rejoin"], ["failed", "retry"], ["replaced", "takeBack"],
    ...["unavailable", "denied", "kicked", "banned", "rejected", "removed", "lobby", "password", "joinLocked"].map(status => [status, undefined])]) {
    test(`status destination ${language}: ${status}`, () => {
      const { text, page } = meetingStatusPage(status, language);
      assert.ok(page.title);
      assert.ok(page.description);
      assert.ok(text.home);
      assert.equal(page.action, action);
      if (action) assert.ok(text[action]);
      assert.equal(/404|500/.test(page.title), false);
    });
  }
}
test("unknown statuses and languages use safe defaults", () => {
  assert.deepEqual(meetingStatusPage("__proto__", "ru").page, meetingStatusPage("failed", "ru").page);
  assert.deepEqual(meetingStatusPage("unknown", "unknown").page, meetingStatusPage("failed", "ru").page);
});
