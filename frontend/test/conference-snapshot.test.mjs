import test from "node:test";
import assert from "node:assert/strict";
import { reconcileConferenceRoomSnapshot } from "../app/studio/lib/conferenceSnapshot.mjs";

const previous = Object.freeze({ scope: "owner", allowed: true, enabled: true, inviteUrl: "/room/example" });
for (const { name, scope, room, expected } of [
  { name: "revocation overrides flags but preserves invitation data", scope: "owner", room: { conference_allowed: false, conference_enabled: false }, expected: { ...previous, allowed: false, enabled: false } },
  { name: "partial room update preserves other flags", scope: "owner", room: { conference_enabled: false }, expected: { ...previous, enabled: false } },
  { name: "invalid fields cannot invent capability", scope: "owner", room: { conference_allowed: "false", conference_enabled: null }, expected: previous },
  { name: "identity switch never retains another invitation", scope: "other", room: { conference_allowed: true }, expected: { scope: "other", allowed: true, enabled: false, inviteUrl: null } },
  { name: "missing fields use the scoped fallback", scope: "other", room: {}, expected: { scope: "other", allowed: false, enabled: false, inviteUrl: null } },
]) {
  test(`conference snapshot compatibility: ${name}`, () => {
    assert.deepEqual(reconcileConferenceRoomSnapshot(previous, scope, room), expected);
    assert.deepEqual(previous, { scope: "owner", allowed: true, enabled: true, inviteUrl: "/room/example" });
  });
}
