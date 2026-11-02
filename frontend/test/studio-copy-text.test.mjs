import assert from "node:assert/strict";
import { test } from "node:test";
import { copyText } from "../app/studio/lib/copyText.mjs";

/** Build a minimal legacy-copy document and expose its cleanup observations. */
function legacyDocument(result = true) {
  const events = [];
  const field = {
    style: {},
    setAttribute: (name, value) => events.push(["attribute", name, value]),
    focus: () => events.push(["focus"]),
    select: () => events.push(["select"]),
    remove: () => events.push(["remove"]),
  };
  return {
    events,
    field,
    documentRef: {
      body: { appendChild: (node) => events.push(["append", node]) },
      createElement: (tag) => {
        events.push(["create", tag]);
        return field;
      },
      execCommand: (command) => {
        events.push(["command", command]);
        return result;
      },
    },
  };
}

test("secure clipboard copy avoids the legacy field", async () => {
  const writes = [];
  const copied = await copyText("room link", {
    clipboard: { writeText: async (value) => writes.push(value) },
    documentRef: null,
  });
  assert.equal(copied, true);
  assert.deepEqual(writes, ["room link"]);
});

test("blocked clipboard falls back to a temporary selected field and cleans it up", async () => {
  const legacy = legacyDocument();
  const copied = await copyText("meeting link", {
    clipboard: { writeText: async () => { throw new Error("insecure context"); } },
    documentRef: legacy.documentRef,
  });
  assert.equal(copied, true);
  assert.equal(legacy.field.value, "meeting link");
  assert.deepEqual(legacy.events.map((event) => event[0]), ["create", "attribute", "append", "focus", "select", "command", "remove"]);
});

test("unavailable copy mechanisms report failure", async () => {
  assert.equal(await copyText("link", { clipboard: null, documentRef: null }), false);
  const legacy = legacyDocument(false);
  assert.equal(await copyText("link", { clipboard: null, documentRef: legacy.documentRef }), false);
  assert.equal(legacy.events.at(-1)[0], "remove");
});
