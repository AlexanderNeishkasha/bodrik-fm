import assert from "node:assert/strict";
import test from "node:test";
import { bindSettingsDialog } from "../features/meeting/settings/settingsDialogLifecycle.mjs";

/** Native modal and two documents expose observer/focus boundaries without sharing or mirroring overlay state. */
function fixture() {
  let parentOverlay = false;
  let childOverlay = false;
  let open = true;
  let synchronize;
  let disconnects = 0;
  let sourceCloses = 0;
  let focusReturns = 0;
  const observed = [];
  const listeners = new Map();
  const parent = {
    activeElement: { isConnected: true, focus: () => { focusReturns++; } },
    body: { classList: { contains: () => parentOverlay } },
    defaultView: { MutationObserver: class {
      constructor(callback) { synchronize = callback; }
      observe(body) { observed.push(body); }
      disconnect() { disconnects++; }
    } },
  };
  const child = { body: { classList: { contains: () => childOverlay } } };
  const dialog = {
    ownerDocument: parent, open: false,
    showModal() { this.open = true; }, close() { this.open = false; },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); },
  };
  const lifecycle = bindSettingsDialog(dialog, {
    overlayDocument: child, getSnapshot: () => ({ open }), close: () => { sourceCloses++; open = false; },
  });
  lifecycle.sync();
  return { lifecycle, dialog, observed, listeners, parent, child,
    setParent: (value) => { parentOverlay = value; synchronize(); },
    setChild: (value) => { childOverlay = value; synchronize(); },
    setOpen: (value) => { open = value; lifecycle.sync(); },
    counts: () => ({ disconnects, sourceCloses, focusReturns }),
  };
}

test("retained child overlay suspends parent settings without changing source visibility or stealing focus", () => {
  const f = fixture();
  assert.deepEqual(f.observed, [f.parent.body, f.child.body]);
  assert.equal(f.dialog.open, true);
  f.setChild(true);
  assert.equal(f.dialog.open, false);
  f.listeners.get("close")();
  let prevented = 0;
  f.listeners.get("cancel")({ target: f.dialog, preventDefault: () => { prevented++; } });
  assert.equal(prevented, 0);
  assert.deepEqual(f.counts(), { disconnects: 0, sourceCloses: 0, focusReturns: 0 });
  f.setChild(false);
  assert.equal(f.dialog.open, true);
  f.setOpen(false);
  assert.equal(f.dialog.open, false);
  assert.equal(f.counts().focusReturns, 1);
  f.lifecycle.dispose();
});

test("simultaneous parent/child overlays retain priority until both are dismissed", () => {
  const f = fixture();
  f.setChild(true);
  f.setParent(true);
  f.setChild(false);
  assert.equal(f.dialog.open, false);
  f.setParent(false);
  assert.equal(f.dialog.open, true);
  f.lifecycle.dispose();
  assert.deepEqual(f.counts(), { disconnects: 1, sourceCloses: 0, focusReturns: 1 });
});

test("observer cleanup during retained overlay releases no source command and restores no competing focus", () => {
  const f = fixture();
  f.setChild(true);
  f.lifecycle.dispose();
  f.lifecycle.dispose();
  f.setChild(false);
  assert.equal(f.dialog.open, false);
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.counts(), { disconnects: 1, sourceCloses: 0, focusReturns: 0 });
});
