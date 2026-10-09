import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// Load the standalone ESM helper without changing the frontend package's module type.
const source = await readFile(new URL("../app/lib/authSession.js", import.meta.url), "utf8");
const auth = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const storageSource = await readFile(new URL("../app/lib/storageKeys.js", import.meta.url), "utf8");
const preferences = await import(`data:text/javascript;base64,${Buffer.from(storageSource).toString("base64")}`);

/** Restore globals without accessing Node's warning-producing localStorage getter. */
function isolate(t) {
  for (const name of ["window", "localStorage"]) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
    delete globalThis[name];
  }
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("Server storage must not be accessed"); },
  });
}

test("SSR auth hints never access Node Web Storage", t => {
  isolate(t);
  assert.equal(auth.getCachedAuthUser(), null);
  assert.equal(auth.hasCachedAuthUser(), false);
  assert.equal(auth.getCachedAuthRole(), null);
  auth.setCachedAuthUser({ login: "fixture" });
  auth.clearCachedAuthUser();
  assert.equal(preferences.getStoredValue("volume"), null);
  preferences.setStoredValue("volume", "0.6");
  preferences.removeStoredValue("volume");
});

test("browser auth cache supports read, role, write and clear", t => {
  isolate(t);
  const storage = new Map();
  globalThis.window = { localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } };
  const user = { login: "fixture", role: "user", actor_role: "admin" };
  auth.setCachedAuthUser(user);
  assert.deepEqual(auth.getCachedAuthUser(), user);
  assert.equal(auth.getCachedAuthRole(), "admin");
  assert.equal(auth.hasCachedAuthUser(), true);
  storage.set("bodrik_fm_auth_user", "invalid-json");
  assert.equal(auth.getCachedAuthUser(), null);
  auth.clearCachedAuthUser();
  assert.equal(storage.size, 0);
  preferences.setStoredValue("volume", "0.6");
  assert.equal(storage.get("bodrik_fm_volume"), "0.6");
  assert.equal(preferences.getStoredValue("volume"), "0.6");
  preferences.removeStoredValue("volume");
  assert.equal(preferences.getStoredValue("volume"), null);
});

test("unavailable browser storage is not an authenticated hint", t => {
  isolate(t);
  globalThis.window = { get localStorage() { throw new Error("Storage denied"); } };
  assert.equal(auth.getCachedAuthUser(), null);
});
