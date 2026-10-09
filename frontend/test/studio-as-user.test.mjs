import assert from "node:assert/strict";
import { test } from "node:test";
import {
  logoutAndResetStudioAsUser,
  parseStudioAsUserIdValue,
} from "../app/studio/lib/studioAsUser.mjs";

test("Studio impersonation IDs accept only positive integers", () => {
  const cases = [
    ["1", 1],
    ["42", 42],
    ["", null],
    ["0", null],
    ["-1", null],
    ["1.5", null],
    ["user", null],
  ];
  for (const [raw, expected] of cases) assert.equal(parseStudioAsUserIdValue(raw), expected, raw);
});

test("Studio logout clears impersonation but navigates only after server success", async (t) => {
  const originalWindow = globalThis.window;
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  for (const loggedOut of [false, true]) {
    let replaced = null;
    let target = 7;
    let navigated = false;
    globalThis.window = {
      location: { href: "https://example.test/studio?as=7#panel" },
      history: {
        state: null,
        replaceState: (_state, _unused, value) => {
          replaced = value;
        },
      },
    };
    const result = await logoutAndResetStudioAsUser({
      setStudioAsUserId: (value) => {
        target = value;
      },
      logout: async () => loggedOut,
      navigateHome: () => {
        navigated = true;
      },
    });
    assert.equal(result, loggedOut);
    assert.equal(target, null);
    assert.equal(replaced, "/studio#panel");
    assert.equal(navigated, loggedOut);
  }
});
