import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PROFILES, PROFILES_KEY, forgetProfile, readProfiles, rememberProfile, replaceProfile } from "../features/meeting/client/profiles.mjs";

const LOCATION = { protocol: "https:", host: "pc.lan:3443" };
const A = "/uploads/avatars/00000000-0000-0000-0000-00000000000a.png";
const B = "/uploads/avatars/00000000-0000-0000-0000-00000000000b.webp";

/** In-memory Storage double; `entries` seeds it. */
function memoryStorage(entries = []) {
  const values = new Map(entries);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

/** Storage seeded with a saved profile list. */
const saved = (list) => memoryStorage([[PROFILES_KEY, JSON.stringify(list)]]);

const readCases = [
  { name: "nothing saved", storage: memoryStorage(), expected: [] },
  { name: "legacy name and avatar migrate", storage: memoryStorage([["meeting.name", " Arwen "], ["meeting.avatar", A]]), expected: [{ name: "Arwen", avatar: A }] },
  { name: "legacy full avatar URL becomes a path", storage: memoryStorage([["meeting.name", "Arwen"], ["meeting.avatar", `https://pc.lan:3443${A}`]]), expected: [{ name: "Arwen", avatar: A }] },
  { name: "saved list wins over legacy keys", storage: memoryStorage([[PROFILES_KEY, "[]"], ["meeting.name", "Old"]]), expected: [] },
  { name: "corrupt JSON reads empty", storage: memoryStorage([[PROFILES_KEY, "{oops"]]), expected: [] },
  { name: "invalid entries and duplicates drop", storage: saved([{ name: "  " }, null, { name: "Bo", avatar: A }, { name: "Bo", avatar: B }, { name: 7 }]), expected: [{ name: "Bo", avatar: A }] },
  { name: "foreign avatar origin drops the picture", storage: saved([{ name: "Bo", avatar: `https://evil.test${A}` }]), expected: [{ name: "Bo", avatar: "" }] },
  { name: "long names are cut to 32", storage: saved([{ name: "x".repeat(40) }]), expected: [{ name: "x".repeat(32), avatar: "" }] },
  { name: "blocked storage reads empty", storage: { getItem() { throw new Error("SecurityError"); } }, expected: [] },
];

for (const item of readCases) {
  test(`readProfiles: ${item.name}`, () => {
    assert.deepEqual(readProfiles(item.storage, LOCATION), item.expected);
  });
}

const rememberCases = [
  { name: "new profile goes first", list: [{ name: "Bo", avatar: A }], value: { name: "Cy", avatar: B }, expected: [{ name: "Cy", avatar: B }, { name: "Bo", avatar: A }] },
  { name: "same name moves first with the new avatar", list: [{ name: "Cy", avatar: B }, { name: "Bo", avatar: A }], value: { name: "Bo", avatar: B }, expected: [{ name: "Bo", avatar: B }, { name: "Cy", avatar: B }] },
  { name: "empty avatar keeps the previous picture", list: [{ name: "Bo", avatar: A }], value: { name: " Bo ", avatar: "" }, expected: [{ name: "Bo", avatar: A }] },
  { name: "blank name changes nothing", list: [{ name: "Bo", avatar: A }], value: { name: " ", avatar: B }, expected: [{ name: "Bo", avatar: A }] },
];

for (const item of rememberCases) {
  test(`rememberProfile: ${item.name}`, () => {
    const storage = saved(item.list);
    assert.deepEqual(rememberProfile(storage, LOCATION, item.value), item.expected);
    assert.deepEqual(readProfiles(storage, LOCATION), item.expected);
  });
}

test("rememberProfile: the least recently used profile drops past the limit", () => {
  const list = Array.from({ length: MAX_PROFILES }, (_, index) => ({ name: `P${index}`, avatar: "" }));
  const next = rememberProfile(saved(list), LOCATION, { name: "New", avatar: "" });
  assert.equal(next.length, MAX_PROFILES);
  assert.equal(next[0].name, "New");
  assert.equal(next.some((profile) => profile.name === `P${MAX_PROFILES - 1}`), false);
});

test("rememberProfile: retires the legacy single-identity keys", () => {
  const storage = memoryStorage([["meeting.name", "Old"], ["meeting.avatar", A]]);
  rememberProfile(storage, LOCATION, { name: "New", avatar: "" });
  assert.deepEqual(readProfiles(storage, LOCATION), [{ name: "New", avatar: "" }, { name: "Old", avatar: A }]);
  assert.equal(storage.values.has("meeting.name"), false);
  assert.equal(storage.values.has("meeting.avatar"), false);
});

const replaceCases = [
  { name: "rename keeps one entry", list: [{ name: "Cy", avatar: "" }, { name: "Bo", avatar: A }], previous: "Bo", value: { name: "Bob", avatar: A }, expected: [{ name: "Bob", avatar: A }, { name: "Cy", avatar: "" }] },
  { name: "rename onto an existing name merges", list: [{ name: "Bo", avatar: A }, { name: "Cy", avatar: B }], previous: "Bo", value: { name: "Cy", avatar: A }, expected: [{ name: "Cy", avatar: A }] },
  { name: "empty avatar clears the picture", list: [{ name: "Bo", avatar: A }], previous: "Bo", value: { name: "Bo", avatar: "" }, expected: [{ name: "Bo", avatar: "" }] },
  { name: "unknown previous name adds", list: [{ name: "Bo", avatar: A }], previous: "", value: { name: "Cy", avatar: B }, expected: [{ name: "Cy", avatar: B }, { name: "Bo", avatar: A }] },
];

for (const item of replaceCases) {
  test(`replaceProfile: ${item.name}`, () => {
    const storage = saved(item.list);
    assert.deepEqual(replaceProfile(storage, LOCATION, item.previous, item.value), item.expected);
    assert.deepEqual(readProfiles(storage, LOCATION), item.expected);
  });
}

test("forgetProfile: removes only the named profile and survives blocked writes", () => {
  const storage = saved([{ name: "Bo", avatar: A }, { name: "Cy", avatar: B }]);
  assert.deepEqual(forgetProfile(storage, LOCATION, "Bo"), [{ name: "Cy", avatar: B }]);
  assert.deepEqual(readProfiles(storage, LOCATION), [{ name: "Cy", avatar: B }]);
  storage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.deepEqual(forgetProfile(storage, LOCATION, "Cy"), []);
});
