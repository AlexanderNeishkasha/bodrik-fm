import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MEETING_EXPAND_MS,
  MEETING_FADE_MS,
  meetingMotionPlan,
} from "../app/studio/lib/meetingMotion.mjs";

test("meeting motion enables expansion before reveal and reverses on disable", () => {
  assert.equal(MEETING_FADE_MS, 140);
  assert.equal(MEETING_EXPAND_MS, 180);
  assert.deepEqual(meetingMotionPlan(true), {
    mount: 0,
    expand: 0,
    reveal: 180,
    collapse: null,
    unmount: null,
  });
  assert.deepEqual(meetingMotionPlan(false), {
    mount: null,
    expand: null,
    reveal: null,
    collapse: 140,
    unmount: 320,
  });
  assert.deepEqual(meetingMotionPlan(true, true), {
    mount: 0,
    expand: 0,
    reveal: 0,
    collapse: 0,
    unmount: 0,
  });
});

test("meeting components use staged hooks and reduced-motion CSS", () => {
  const conference = readFileSync(new URL("../app/studio/components/ConferenceControls.js", import.meta.url), "utf8");
  const actionCss = readFileSync(new URL("../app/studio/components/ConferenceControls.module.css", import.meta.url), "utf8");
  assert.match(conference, /useMeetingOutputPresence/);
  assert.match(actionCss, /opacity 140ms ease-out/);
  assert.match(actionCss, /grid-template-rows 180ms ease-out/);
  assert.match(actionCss, /prefers-reduced-motion: reduce/);
});
