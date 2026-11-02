import { test } from "node:test";
import assert from "node:assert/strict";
import {
  create,
  sections,
} from "../features/meeting/settings/settingsShellModel.mjs";

/** Inject only visible sections; the shell has no signaling or media dependencies. */
function fixture(initial = [...sections]) {
  let available = initial;
  const source = create({
    getAvailableSections: () => available,
  });
  return {
    source,
    setAvailable: (next) => {
      available = next;
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
  h.setAvailable(["tabShortcuts", "tabRoom"]);
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
  h.source.dispose();
  h.source.refresh();
  assert.equal(count, 0);
  assert.throws(() => h.source.execute("open"), /disposed/);
});

for (const available of [null, {}, ["missing"]]) {
  test(`settings shell fails closed on malformed capability list ${JSON.stringify(available)}`, () => {
    assert.throws(() => fixture(available), /Invalid settings section/);
  });
}
