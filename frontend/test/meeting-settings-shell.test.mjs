import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  create,
  sections,
} from "../features/meeting/settings/settingsShellModel.mjs";

/** Inject only visibility and language; the shell has no signaling/media dependencies. */
function fixture(initial = [...sections]) {
  let available = initial;
  let language = "ru";
  const source = create({
    getAvailableSections: () => available,
    getLanguage: () => language,
  });
  return {
    source,
    setAvailable: (next) => {
      available = next;
    },
    setLanguage: (next) => {
      language = next;
    },
  };
}

for (const id of sections) {
  test(`settings shell selects retained section ${id} without opening or issuing domain commands`, () => {
    const h = fixture();
    h.source.execute("select", id);
    assert.equal(h.source.getSnapshot().selected, id);
    assert.equal(h.source.getSnapshot().open, false);
    h.source.execute("open");
    assert.equal(h.source.getSnapshot().open, true);
    h.source.execute("close");
    const closed = h.source.getSnapshot();
    h.source.execute("close");
    assert.equal(h.source.getSnapshot(), closed);
    h.source.dispose();
  });
}

for (const [name, command, value, available] of [
  ["unknown section", "select", "missing", sections],
  ["hidden section", "select", "tabModerator", ["tabRoom"]],
  ["unknown command", "toggle", undefined, sections],
  ["unexpected open payload", "open", true, sections],
  ["unexpected close payload", "close", true, sections],
  ["empty shell", "open", undefined, []],
]) {
  test(`settings shell rejects ${name}`, () => {
    const h = fixture(available);
    const before = h.source.getSnapshot();
    assert.throws(() => h.source.execute(command, value));
    assert.equal(h.source.getSnapshot(), before);
    h.source.dispose();
  });
}

test("settings shell capability removal selects first retained available section, then closes when empty", () => {
  const h = fixture();
  h.source.execute("select", "tabModerator");
  h.source.execute("open");
  h.setAvailable(["tabLanguages", "tabRoom"]);
  h.source.refresh();
  assert.equal(h.source.getSnapshot().selected, "tabRoom");
  assert.equal(h.source.getSnapshot().open, true);
  h.setAvailable([]);
  h.source.refresh();
  assert.equal(h.source.getSnapshot().selected, null);
  assert.equal(h.source.getSnapshot().open, false);
  h.source.dispose();
});

test("settings shell snapshots are immutable/stable and notify only actual view changes", () => {
  const h = fixture();
  let count = 0;
  h.source.subscribe(() => count++);
  const before = h.source.getSnapshot();
  h.source.refresh();
  assert.equal(h.source.getSnapshot(), before);
  assert.equal(count, 0);
  assert.ok(Object.isFrozen(before));
  assert.ok(Object.isFrozen(before.available));
  h.setLanguage("en");
  h.source.refresh();
  assert.equal(count, 1);
  assert.equal(h.source.getSnapshot().language, "en");
  h.source.dispose();
  h.source.refresh();
  assert.equal(count, 1);
  assert.throws(() => h.source.execute("open"), /disposed/);
});

for (const available of [null, {}, ["missing"]]) {
  test(`settings shell fails closed on malformed capability list ${JSON.stringify(available)}`, () => {
    assert.throws(() => fixture(available), /Invalid settings section/);
  });
}

test("settings shell keeps stable scrollable content and a horizontal mobile category rail", () => {
  const css = readFileSync(new URL("../features/meeting/settings/SettingsShell.module.css", import.meta.url), "utf8");
  assert.match(css, /width:\s*min\(960px,\s*calc\(100vw\s*-\s*24px\)\)/);
  assert.match(css, /height:\s*min\(720px,\s*calc\(100dvh\s*-\s*24px\)\)/);
  assert.match(css, /\.panels\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /@media\s*\(max-width:\s*600px\)/);
  assert.match(css, /\.navigation\s*\{[^}]*overflow-x:\s*auto;\s*overflow-y:\s*hidden/);
  assert.doesNotMatch(css, /flex-wrap:\s*wrap/);
  assert.match(css, /button:hover::after[^}]*visibility:\s*visible/);
});
