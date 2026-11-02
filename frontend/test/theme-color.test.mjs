import assert from "node:assert/strict";
import { test } from "node:test";
import { watchThemeColor } from "../app/lib/themeColor.mjs";

/** Minimal DOM: `--theme-bg` per data-theme, one head and a recording MutationObserver. */
function fakeDocument(colors) {
  const attributes = new Map();
  const head = { children: [], querySelector: (selector) => head.children.find((node) => selector.includes(node.attributes.get("name"))) ?? null, appendChild: (node) => head.children.push(node) };
  const listeners = new Map();
  const observers = [];
  const root = {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute(name, value) {
      attributes.set(name, value);
      for (const observer of observers) observer();
    },
  };
  const element = () => {
    const nodeAttributes = new Map();
    return { attributes: nodeAttributes, getAttribute: (name) => nodeAttributes.get(name) ?? null, setAttribute: (name, value) => nodeAttributes.set(name, value) };
  };
  const document = {
    documentElement: root,
    head,
    createElement: element,
    defaultView: {
      getComputedStyle: () => ({ getPropertyValue: (name) => (name === "--theme-bg" ? colors[root.getAttribute("data-theme")] ?? "" : "") }),
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
  };
  class MutationObserverImpl {
    constructor(callback) { this.callback = callback; }
    observe(target, options) {
      assert.equal(target, root);
      assert.deepEqual(options.attributeFilter, ["data-theme"]);
      observers.push(this.callback);
    }
  }
  const color = () => head.children.find((node) => node.getAttribute("name") === "theme-color")?.getAttribute("content") ?? null;
  return { document, root, color, fireLoad: () => listeners.get("load")?.(), metaCount: () => head.children.length, MutationObserverImpl };
}

test("theme-color follows the active theme background", () => {
  const page = fakeDocument({ pirate: "#262626", noir: " #070707 " });
  page.root.setAttribute("data-theme", "pirate");
  watchThemeColor({ document: page.document, MutationObserverImpl: page.MutationObserverImpl });
  assert.equal(page.color(), "#262626", "initial theme");
  page.root.setAttribute("data-theme", "noir");
  assert.equal(page.color(), "#070707", "theme switch, token trimmed");
  page.root.setAttribute("data-theme", "pirate");
  assert.equal(page.metaCount(), 1, "one meta element is reused");
});

test("theme-color waits for theme CSS before writing", () => {
  const colors = {};
  const page = fakeDocument(colors);
  page.root.setAttribute("data-theme", "aurora");
  watchThemeColor({ document: page.document, MutationObserverImpl: page.MutationObserverImpl });
  assert.equal(page.color(), null, "no token yet: no empty meta");
  colors.aurora = "#0b1b1f";
  page.fireLoad();
  assert.equal(page.color(), "#0b1b1f", "applied once stylesheets load");
});
