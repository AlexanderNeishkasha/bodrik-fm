import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = ["room/MeetingGrid.js", "media/ParticipantCard.js", "media/MediaTrack.js"].map((name) =>
  readFileSync(new URL(`../features/meeting/${name}`, import.meta.url), "utf8")).join("\n");

test("card views bind caller-owned tracks without stopping them", () => {
  assert.match(source, /useSyncExternalStore\(registry\.subscribe, registry\.getSnapshot/);
  assert.match(source, /bindMediaTrack\(element, track\)/);
  assert.match(source, /\}, \[track\]\)/);
  assert.doesNotMatch(source, /track\.stop\(/);
});

test("card views never render audio; MeetingAudio is the single audio renderer", () => {
  assert.doesNotMatch(source, /<audio\b/);
  assert.match(source, /source\.kind !== "audio"/);
});

test("cards include participant, presenter, speaking and music projections", () => {
  for (const value of ["participant.name", "participant.presenter", "participant.speaking", "Бодрик FM"])
    assert.match(source, new RegExp(value.replace(".", "\\.")));
});
