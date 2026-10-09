import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { resolveSettingsSection } from "../features/meeting/settings/settingsWorkspaceBindings.mjs";

/** Test authorities reject all resource/command access; render may only read the supplied immutable snapshot. */
function source(snapshot = {}) {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => { throw new Error("Static render must not subscribe"); },
    execute: () => { throw new Error("Render must not issue commands"); },
    dispose: () => { throw new Error("View must not dispose feature ownership"); },
  };
}
const sources = Object.fromEntries(["audio", "video", "background", "profile", "policy", "personal", "roomInfo"].map((key) => [key, source()]));
for (const [section, keys, kinds] of [
  ["tabAudioDevices", ["audio"], [undefined]],
  ["tabVideoDevices", ["video"], [undefined]],
  ["tabProfile", ["profile"], [undefined]],
  ["tabRoom", ["roomInfo", "policy"], [undefined, "room"]],
  ["tabModerator", ["policy"], ["moderator"]],
  ["tabShortcuts", ["personal"], ["shortcuts"]],
  ["tabLanguages", ["personal"], ["language"]],
]) {
  test(`workspace composes existing feature owners: ${section}`, () => {
    const bindings = resolveSettingsSection(section, sources);
    assert.equal(Object.isFrozen(bindings), true);
    assert.equal(bindings.length, keys.length);
    bindings.forEach((binding, index) => {
      assert.equal(binding.source, sources[keys[index]]);
      assert.equal(binding.kind, kinds[index]);
      assert.equal(Object.isFrozen(binding), true);
    });
  });
}
for (const section of ["unknown", "__proto__", "constructor", "tabRecording"]) {
  test(`workspace rejects unregistered section ${section}`, () => {
    assert.throws(() => resolveSettingsSection(section, sources), /Unsupported/);
  });
}
for (const invalid of [null, {}, { getSnapshot() {}, subscribe() {} }]) {
  test(`workspace never invents missing feature source ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => resolveSettingsSection("tabRoom", { ...sources, policy: invalid }), /source unavailable/);
  });
}

/** Compile the actual component tree; static rendering has no window/document/storage/media globals. */
async function renderer() {
  const result = await build({
    stdin: { contents: 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import Workspace from "./features/meeting/settings/SettingsWorkspace.js"; export const render = props => renderToStaticMarkup(React.createElement(Workspace, props));',
      resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, format: "cjs", platform: "node", write: false, outdir: "out", jsx: "automatic",
    define: { "process.env.NEXT_PUBLIC_ASSET_PREFIX": JSON.stringify("") },
    loader: { ".js": "jsx", ".css": "empty" }, external: ["react", "react/*", "react-dom", "react-dom/*"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find((file) => file.path.endsWith(".js")).text, {
    module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url),
  });
  return evaluated.exports.render;
}
const render = await renderer();
for (const language of ["ru", "en"]) {
  test(`normal settings workspace renders feature views without legacy mounts: ${language}`, () => {
    const html = render({
      source: source({ language, available: ["tabProfile", "tabVideoDevices"], selected: "tabProfile", open: false }),
      sources: {
        profile: source({ language, name: "Fixture", avatar: "/fixture.webp", presenter: false, customAvatar: false, available: false, details: [] }),
        video: source({ language, cameras: [], camera: "", qualities: [], quality: "", frameRates: [], frameRate: "", screenQualities: [], screenQuality: "",
          screenFrameRates: [], screenFrameRate: "", screenHints: [], screenHint: "", cameraAllowed: true, effects: [{ value: "off" }], effect: "off", effectSupported: true }),
      },
    });
    assert.match(html, /role="tablist"/);
    assert.equal(html.split('role="tabpanel"').length - 1, 2);
    assert.match(html, /Fixture/);
    assert.match(html, new RegExp(language === "ru" ? "Настройки встречи" : "Meeting settings"));
    assert.doesNotMatch(html, /<slot|shadowroot|iframe|mySettings|tabProfileBtn/);
  });
}
