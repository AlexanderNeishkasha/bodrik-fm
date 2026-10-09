import assert from "node:assert/strict";
import { test } from "node:test";

test("takeHostGrant reads and strips the Studio host pass", async () => {
  const { takeHostGrant } = await import("../features/meeting/client/protocol.mjs");
  const valid = "a".repeat(64);
  for (const [name, hash, expected, stripped] of [
    ["valid pass", `#host=${valid}`, valid, true],
    ["among other fragment parts", `#x=1&host=${valid}`, valid, true],
    ["malformed pass is dropped but stripped", "#host=not-a-pass", "", true],
    ["no pass", "#other", "", false],
    ["empty fragment", "", "", false],
  ]) {
    const calls = [];
    const history = { state: null, replaceState: (...args) => calls.push(args) };
    const location = { hash, pathname: "/room/r", search: "?a=1" };
    assert.equal(takeHostGrant(location, history), expected, name);
    assert.deepEqual(calls.map((call) => call[2]), stripped ? ["/room/r?a=1"] : [], name);
  }
});

test("requestGuestTicket sends the host pass only when given", async () => {
  const { requestGuestTicket } = await import("../features/meeting/client/protocol.mjs");
  for (const [name, hostGrant, body] of [["with pass", "b".repeat(64), JSON.stringify({ hostGrant: "b".repeat(64) })], ["without pass", "", "{}"]]) {
    let sent = null;
    const fetchImpl = async (url, init) => { sent = init.body; return { ok: true, json: async () => ({ version: 1, ticket: "t", roomSlug: "r" }) }; };
    await requestGuestTicket("r", { fetchImpl, hostGrant });
    assert.equal(sent, body, name);
  }
});
