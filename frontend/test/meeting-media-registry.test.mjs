import assert from "node:assert/strict";
import test from "node:test";

import { createMediaRegistry } from "../features/meeting/media/mediaRegistry.mjs";

const alice = { id: "alice", name: "Alice", presenter: true };
const camera = { id: "camera-a", participantId: "alice", kind: "camera", consumerId: "consumer-a" };

test("media registry publishes immutable participant/source snapshots idempotently", () => {
  const registry = createMediaRegistry();
  let changes = 0;
  registry.subscribe(() => changes += 1);
  assert.equal(registry.replace([alice], [camera]), true);
  const snapshot = registry.getSnapshot();
  assert.equal(changes, 1);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.participants), true);
  assert.equal(registry.replace([alice], [camera]), false);
  assert.equal(changes, 1);
});

test("participant updates and late joins reconcile without recreating unchanged sources", () => {
  const registry = createMediaRegistry();
  registry.replace([alice], [camera]);
  const track = { kind: "video" };
  registry.attachTrack(camera.id, track);
  const bob = { id: "bob", name: "Bob" };
  registry.replace([{ ...alice, name: "Alicia", speaking: true }, bob], [camera]);
  assert.equal(registry.getSnapshot().participants[0].name, "Alicia");
  assert.equal(registry.getSnapshot().participants[0].speaking, true);
  assert.equal(registry.getSnapshot().participants.length, 2);
  assert.equal(registry.getTrack(camera.id), track);
  const unchanged = registry.getSnapshot();
  assert.equal(registry.replace([{ ...alice, name: "Alicia", speaking: true }, bob], [camera]), false);
  assert.equal(registry.getSnapshot(), unchanged);
  registry.replace([bob], []);
  assert.equal(registry.attachTrack(camera.id, track), false);
  assert.equal(registry.getSnapshot().participants[0].id, "bob");
});

for (const [name, avatar, expected] of [
  ["uploaded image", "/uploads/avatars/alice.webp", "/uploads/avatars/alice.webp"],
  ["remote image", "https://outside.invalid/alice.png", ""],
  ["script URL", "javascript:alert(1)", ""],
  ["query credentials", "/uploads/avatars/alice.png?token=secret", ""],
  ["unrelated public file", "/images/participant.png", ""],
]) {
  test(`participant avatar projection: ${name}`, () => {
    const registry = createMediaRegistry();
    registry.replace([{ ...alice, avatar }]);
    assert.equal(registry.getSnapshot().participants[0].avatar, expected);
  });
}

test("media registry removes stale sources and caller-owned tracks", () => {
  const registry = createMediaRegistry();
  const track = { kind: "video" };
  registry.replace([alice], [camera]);
  assert.equal(registry.attachTrack("camera-a", track), true);
  assert.equal(registry.attachTrack("camera-a", track), false);
  assert.equal(registry.getTrack("camera-a"), track);
  registry.replace([alice], []);
  assert.equal(registry.getTrack("camera-a"), null);
});

for (const [name, participants, sources] of [
  ["duplicate participants", [alice, alice], []],
  ["duplicate sources", [alice], [camera, camera]],
  ["missing owner", [], [camera]],
  ["invalid kind", [alice], [{ ...camera, kind: "data" }]],
]) {
  test(`media registry rejects ${name}`, () => {
    assert.throws(() => createMediaRegistry().replace(participants, sources));
  });
}

test("late and replacement tracks publish revisions without stopping caller resources", () => {
  const registry = createMediaRegistry();
  registry.replace([alice], [{ ...camera, local: true, consumerId: "" }]);
  let changes = 0;
  registry.subscribe(() => changes += 1);
  const first = { kind: "video", stop() { throw new Error("Caller owns track"); } };
  const second = { kind: "video" };
  const before = registry.getSnapshot();
  assert.equal(registry.attachTrack(camera.id, first), true);
  assert.notEqual(registry.getSnapshot(), before);
  assert.equal(registry.getSnapshot().trackRevision, 1);
  assert.equal(registry.attachTrack(camera.id, first), false);
  assert.equal(registry.attachTrack(camera.id, second), true);
  assert.equal(registry.getSnapshot().trackRevision, 2);
  assert.equal(changes, 2);
  registry.dispose();
});

test("disposed media registry cannot retain or publish later work", () => {
  const registry = createMediaRegistry();
  registry.replace([alice], [camera]);
  registry.dispose();
  assert.throws(() => registry.replace([alice], [camera]));
  assert.equal(registry.getTrack("camera-a"), null);
});
