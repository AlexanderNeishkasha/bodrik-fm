import test from "node:test";
import assert from "node:assert/strict";
import { createTooltipLayer } from "../components/ui/tooltipLayer.js";

/** Model only stylesheet and composed-parent boundaries; no real browser modal behavior is claimed by these tests. */
function fixture(mode) {
  const bodyChildren = [];
  const modalChildren = [];
  const body = { append: (host) => bodyChildren.push(host) };
  const modal = { append: (host) => modalChildren.push(host) };
  const css = { styleSheets: [{ cssRules: [
    { selectorText: ".tooltip-token", cssText: ".tooltip-token { color: white; }" },
    { selectorText: "body", cssText: "body { color: red; }" },
  ] }] };
  const document = { body,
    defaultView: { getComputedStyle: () => ({ font: "15px serif", color: "white", getPropertyValue: () => "test-value" }) },
    createElement: (tag) => ({ tag, style: { setProperty() {} }, setAttribute() {},
      attachShadow: () => ({ append() {} }),
      remove() { for (const children of [bodyChildren, modalChildren]) { const index = children.indexOf(this); if (index >= 0) children.splice(index, 1); } },
    }),
  };
  const anchor = { ownerDocument: document, getRootNode: () => css };
  if (mode === "native modal") anchor.closest = () => modal;
  if (mode === "slotted island") {
    const slot = { closest: () => modal };
    css.host = { assignedSlot: slot };
  }
  if (mode === "ancestry cycle") css.host = anchor;
  return { anchor, bodyChildren, modalChildren };
}

for (const mode of ["ordinary panel", "native modal", "slotted island", "ancestry cycle"]) {
  test(`isolated tooltip mount follows ${mode} ancestry and releases only its own layer`, () => {
    const h = fixture(mode);
    const layer = createTooltipLayer(h.anchor, "tooltip-token");
    const modal = ["native modal", "slotted island"].includes(mode);
    assert.equal(h.modalChildren.length, modal ? 1 : 0);
    assert.equal(h.bodyChildren.length, modal ? 0 : 1);
    layer.syncAppearance();
    assert.equal(layer.host.style.font, "15px serif");
    assert.equal(layer.host.style.color, "white");
    layer.dispose();
    assert.equal(h.modalChildren.length + h.bodyChildren.length, 0);
  });
}
