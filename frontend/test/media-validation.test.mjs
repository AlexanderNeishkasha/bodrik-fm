import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ui } from "../app/lang/ru.js";

// Follow the existing helper-unit harness without changing the frontend package type.
const helper = await readFile(new URL("../app/studio/lib/localizeApiMessage.js", import.meta.url), "utf8");
const languageUrl = new URL("../app/lang/ru.js", import.meta.url).href;
const source = helper.replace('"../../lang/ru"', JSON.stringify(languageUrl));
const { localizeApiMessage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("media validation messages and localization fallback branches", () => {
  const cases = [
    ["empty upload", ui.messages.emptyUpload],
    ["upload too large", ui.messages.uploadTooLarge],
    ["invalid theme", ui.messages.invalidTheme],
    [" INVALID POSITION ", ui.messages.invalidPosition],
    ["", "fallback"],
    [null, "fallback"],
    ["failed: internal detail", ui.messages.actionFailed],
    ["conversion failed", ui.messages.actionFailed],
    ["unknown message", "unknown message"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(localizeApiMessage(raw, "fallback"), expected, String(raw));
  }
});
