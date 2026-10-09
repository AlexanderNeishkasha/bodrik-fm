import test from "node:test";
import assert from "node:assert/strict";
import { bindSettingsDialog } from "../features/meeting/settings/settingsDialogLifecycle.mjs";

/** Native dialog/focus/observer boundary stub: no media or browser admission is simulated. */
function fixture() {
  let open = false;
  let overlay = false;
  let observer;
  let disconnected = 0;
  let focused = 0;
  let closes = 0;
  const listeners = new Map();
  const opener = { isConnected: true, focus: () => focused++ };
  const document = { activeElement: opener, body: { classList: { contains: () => overlay } },
    defaultView: { MutationObserver: class {
      /** Capture only the owned external-overlay observer callback. */
      constructor(callback) { observer = callback; }
      /** Observe fixture body-class mutations only. */
      observe() {}
      /** Count teardown rather than silently keeping the observer alive. */
      disconnect() { disconnected++; }
    } } };
  const dialog = { ownerDocument: document, open: false,
    getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 500 }),
    showModal() { this.open = true; }, close() { this.open = false; },
    addEventListener: (event, callback) => listeners.set(event, callback),
    removeEventListener: (event, callback) => { assert.equal(listeners.get(event), callback); listeners.delete(event); } };
  const lifecycle = bindSettingsDialog(dialog, { getSnapshot: () => ({ open }), close: () => { closes++; open = false; lifecycle.sync(); } });
  return { lifecycle, dialog, listeners, opener, focused: () => focused, closes: () => closes, disconnected: () => disconnected,
    setOpen: (value) => { open = value; lifecycle.sync(); },
    setOverlay: (value) => { overlay = value; observer(); } };
}

test("settings dialog follows source open/close and restores only connected opener focus", () => {
  const h = fixture();
  h.setOpen(true);
  assert.equal(h.dialog.open, true);
  h.setOpen(false);
  assert.equal(h.dialog.open, false);
  assert.equal(h.focused(), 1);
  h.setOpen(true);
  h.opener.isConnected = false;
  h.setOpen(false);
  assert.equal(h.focused(), 1);
  h.lifecycle.dispose();
});

test("external Swal suspension preserves source visibility and ignores queued close/reopen events", () => {
  const h = fixture();
  h.setOpen(true);
  h.setOverlay(true);
  assert.equal(h.dialog.open, false);
  h.listeners.get("close")();
  assert.equal(h.closes(), 0);
  assert.equal(h.focused(), 0);
  h.setOverlay(false);
  assert.equal(h.dialog.open, true);
  h.listeners.get("close")();
  assert.equal(h.closes(), 0);
  h.setOpen(false);
  assert.equal(h.focused(), 1);
  h.lifecycle.dispose();
});

for (const mode of ["settings", "nested overlay", "already prevented", "other target"]) {
  test(`settings Escape ownership: ${mode}`, () => {
    const h = fixture();
    h.setOpen(true);
    if (mode === "nested overlay") h.setOverlay(true);
    let prevented = 0;
    h.listeners.get("cancel")({ target: mode === "other target" ? {} : h.dialog,
      defaultPrevented: mode === "already prevented", preventDefault: () => prevented++ });
    assert.equal(h.closes(), mode === "settings" ? 1 : 0);
    assert.equal(prevented, mode === "settings" ? 1 : 0);
    h.lifecycle.dispose();
  });
}

test("settings dialog disposal releases modal/listeners/observer exactly once without a source close command", () => {
  const h = fixture();
  h.setOpen(true);
  h.lifecycle.dispose(); h.lifecycle.dispose();
  assert.equal(h.dialog.open, false);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.disconnected(), 1);
  assert.equal(h.focused(), 1);
  assert.equal(h.closes(), 0);
});


for (const scenario of ["backdrop", "padding", "content", "drag from inside", "cancelled", "nested overlay"]) {
  test(`settings backdrop dismissal: ${scenario}`, () => {
    const h = fixture();
    h.setOpen(true);
    const outside = { target: h.dialog, clientX: 50, clientY: 50 };
    const inside = { target: h.dialog, clientX: 200, clientY: 200 };
    const content = { target: {}, clientX: 200, clientY: 200 };
    h.listeners.get("pointerdown")(scenario === "content" ? content : scenario === "padding" || scenario === "drag from inside" ? inside : outside);
    if (scenario === "cancelled") h.listeners.get("pointercancel")();
    if (scenario === "nested overlay") h.setOverlay(true);
    h.listeners.get("click")(scenario === "content" ? content : scenario === "padding" ? inside : outside);
    assert.equal(h.closes(), scenario === "backdrop" ? 1 : 0);
    h.lifecycle.dispose();
    assert.equal(h.listeners.size, 0);
  });
}
