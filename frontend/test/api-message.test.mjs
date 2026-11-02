import assert from "node:assert/strict";
import { test } from "node:test";
import { readApiMessage } from "../app/lib/apiMessage.js";
import { t } from "../app/lang/index.js";

test("API error bodies localize known messages and fall back otherwise", async () => {
  const cases = [
    ["known message", JSON.stringify({ message: "slug exists" }), undefined, t("messages.slugExists")],
    ["unknown message passes through", JSON.stringify({ message: "teapot" }), undefined, "teapot"],
    ["missing message", JSON.stringify({}), undefined, t("messages.actionFailed")],
    ["invalid JSON", "<html>", undefined, t("messages.actionFailed")],
    ["custom fallback", "<html>", t("messages.loginFailed"), t("messages.loginFailed")],
  ];
  for (const [name, body, fallback, expected] of cases) {
    assert.equal(await readApiMessage(new Response(body), fallback), expected, name);
  }
});
