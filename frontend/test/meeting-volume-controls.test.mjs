import assert from "node:assert/strict";
import test from "node:test";
import { isConferenceMusicActive, meetingVolumeControls } from "../app/studio/lib/meetingVolumeControls.mjs";

/** Exercise the shared Studio slider when the room meeting changes independently of output preference. */
test("disabling a meeting restores the local Studio slider and keeps both saved volumes", () => {
  const changes = [];
  const localChange = (event) => changes.push(["studio", event.target.value]);
  const localMute = () => changes.push(["studio mute"]);
  const conference = {
    musicVolume: 0.4,
    setMusicVolume: (volume) => changes.push(["meeting", volume]),
  };
  const props = (enabled) => meetingVolumeControls({
    state: { conference_enabled: enabled, music_output: "conference", conference_music_volume: 0.4 },
    conference,
    localVolume: 0.7,
    localMuted: false,
    toggleLocalMute: localMute,
    onLocalVolumeChange: localChange,
  });

  assert.equal(isConferenceMusicActive({ conference_enabled: true, music_output: "conference" }), true);
  const active = props(true);
  assert.equal(active.musicOutput, "conference");
  assert.equal(active.localVolume, 0.4);
  active.onVolumeChange({ target: { value: "0.2" } });
  assert.deepEqual(changes, [["meeting", 0.2]]);

  const disabled = props(false);
  assert.equal(isConferenceMusicActive({ conference_enabled: false, music_output: "conference" }), false);
  assert.equal(disabled.musicOutput, "studio");
  assert.equal(disabled.localVolume, 0.7);
  assert.equal(disabled.localMuted, false);
  disabled.onVolumeChange({ target: { value: "0.6" } });
  disabled.onToggleMute();
  assert.deepEqual(changes, [["meeting", 0.2], ["studio", "0.6"], ["studio mute"]]);
  assert.equal(conference.musicVolume, 0.4);
  assert.equal(props(true).localVolume, 0.4);
});

/** Explicit Studio output and absent room state must never take over the meeting master gain. */
test("Studio output is local even while meeting permission remains enabled", () => {
  for (const state of [null, { conference_enabled: true, music_output: "studio" }]) {
    const controls = meetingVolumeControls({ state, localVolume: 0.3, localMuted: true });
    assert.equal(controls.musicOutput, "studio");
    assert.equal(controls.localVolume, 0.3);
    assert.equal(controls.localMuted, true);
  }
});
