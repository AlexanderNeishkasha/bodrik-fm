import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { t } from "../app/lang/index.js";

// Follow the existing helper-unit harness without changing the frontend package type.
const helper = await readFile(new URL("../app/studio/lib/localizeApiMessage.js", import.meta.url), "utf8");
const languageUrl = new URL("../app/lang/index.js", import.meta.url).href;
const source = helper.replace('"../../lang/index.js"', JSON.stringify(languageUrl));
const { localizeApiMessage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("media validation messages and localization fallback branches", () => {
  const cases = [
    ["empty upload", t("messages.emptyUpload")],
    ["upload too large", t("messages.uploadTooLarge")],
    ["invalid theme", t("messages.invalidTheme")],
    [" INVALID POSITION ", t("messages.invalidPosition")],
    ["", "fallback"],
    [null, "fallback"],
    ["failed: internal detail", t("messages.actionFailed")],
    ["conversion failed", t("messages.actionFailed")],
    ["unknown message", "unknown message"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(localizeApiMessage(raw, "fallback"), expected, String(raw));
  }
});
