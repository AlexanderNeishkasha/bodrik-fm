import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpeakerTest } from "../features/meeting/room/speakerTest.mjs";

for (const scenario of ["completion", "replacement", "leave", "routing failure", "play failure", "leave while routing"]) {
  test(`speaker melody lifecycle: ${scenario}`, async () => {
    const sounds = [];
    let finishRouting;
    const player = createSpeakerTest({ volume: () => 0.6, createAudio(url) {
      const sound = { url, plays: 0, pauses: 0, loads: 0,
        async setSinkId(value) {
          this.sink = value;
          if (scenario === "routing failure") throw new Error("routing failed");
          if (scenario === "leave while routing") await new Promise((resolve) => { finishRouting = resolve; });
        },
        async play() { this.plays++; if (scenario === "play failure") throw new Error("play failed"); },
        pause() { this.pauses++; }, removeAttribute(name) { assert.equal(name, "src"); this.url = ""; }, load() { this.loads++; },
      };
      sounds.push(sound);
      return sound;
    } });
    const pending = player.play("selected-speaker");
    const sound = sounds[0];
    assert.equal(sound.url, "/meeting-assets/sounds/speaker.wav");
    assert.equal(sound.volume, 0.3);
    assert.equal(sound.sink, "selected-speaker");
    if (scenario.endsWith("failure")) await assert.rejects(pending, /failed/);
    else {
      if (scenario === "leave while routing") { player.stop(); finishRouting(); }
      await pending;
      if (scenario === "completion") sound.onended();
      if (scenario === "replacement") await player.play("second-speaker");
      if (scenario === "leave") player.stop();
    }
    assert.equal(sound.pauses, 1);
    assert.equal(sound.loads, 1);
    assert.equal(sound.onended, null);
    assert.equal(sound.plays, scenario === "routing failure" || scenario === "leave while routing" ? 0 : 1);
    player.stop();
  });
}


test("speaker test publishes start/stop and updates active volume", async () => {
  let volume = 1;
  const audio = { async play() {}, pause() {}, removeAttribute() {}, load() {} };
  const player = createSpeakerTest({ volume: () => volume, createAudio: () => audio });
  const states = [];
  const off = player.subscribe(() => states.push(player.getSnapshot()));
  await player.play("");
  volume = 0.4;
  player.syncVolume();
  assert.equal(audio.volume, 0.2);
  player.stop();
  assert.deepEqual(states, [true, false]);
  off();
});
