import assert from "node:assert/strict";
import { test } from "node:test";
import { readApiMessage } from "../app/lib/apiMessage.js";
import { ui } from "../app/lang/ru.js";

test("API error bodies localize known messages and fall back otherwise", async () => {
  const cases = [
    ["known message", JSON.stringify({ message: "slug exists" }), undefined, ui.messages.slugExists],
    ["unknown message passes through", JSON.stringify({ message: "teapot" }), undefined, "teapot"],
    ["missing message", JSON.stringify({}), undefined, ui.messages.actionFailed],
    ["invalid JSON", "<html>", undefined, ui.messages.actionFailed],
    ["custom fallback", "<html>", ui.messages.loginFailed, ui.messages.loginFailed],
  ];
  for (const [name, body, fallback, expected] of cases) {
    assert.equal(await readApiMessage(new Response(body), fallback), expected, name);
  }
});
