import assert from "node:assert/strict";
import { test } from "node:test";

import { t } from "../app/lang/index.js";
import { ru } from "../app/lang/ru.js";
import { meetingUiEn } from "../app/lang/eng.js";

test("t resolves leaf copy and retained namespaces", () => {
  assert.equal(t("studio.queue"), "Очередь");
  assert.equal(t("meeting.meetingStatusCopy").left.title, "До встречи!");
});

test("t interpolates named values without dropping missing placeholders", () => {
  assert.equal(t("meeting.notifications.joined", { name: "Бодрик" }), "Бодрик присоединяется к встрече");
  assert.match(t("meeting.notifications.joined"), /\{name\}/);
});

for (const [language, copy, names] of [
  ["Russian", ru.meeting, ["Умное", "Студийное"]],
  ["English", meetingUiEn, ["Smart", "Studio"]],
]) {
  test(`audio help uses visible mode names and no implementation jargon: ${language}`, () => {
    const points = copy.audioSettings.noiseHelp;
    assert.equal(points.length, 4);
    assert.ok(points.every(point => typeof point === "string" && point.length > 0));
    for (const name of names) {
      assert.ok(points.some(point => point.startsWith(name + ":")));
    }
    assert.doesNotMatch(points.join(" ") + copy.micProcessingSettings.gainHelp,
      /RNNoise|DeepFilterNet|нейросет|neural|\b\d+\b|МБ|кГц|\bMB\b|\bkHz\b/i);
  });
}

test("t rejects unknown and inherited paths", () => {
  for (const key of ["", "missing", "studio.missing", "__proto__.toString"]) {
    assert.throws(() => t(key), /Unknown UI copy key/, key);
  }
});
