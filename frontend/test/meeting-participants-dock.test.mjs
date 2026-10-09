import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { createParticipantsSource } from "../features/meeting/participants/participantsModel.mjs";

/** Compile the actual dock tree for static rendering without browser, socket or media globals. */
async function renderer() {
  const result = await build({
    stdin: { contents: 'import React from "react"; import {renderToStaticMarkup} from "react-dom/server"; import Dock from "./features/meeting/participants/ParticipantsDock.js"; export const render = p => renderToStaticMarkup(React.createElement(Dock, p));',
      resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, format: "cjs", platform: "node", write: false, outdir: "out", jsx: "automatic",
    loader: { ".js": "jsx", ".css": "empty" }, external: ["react", "react/*", "react-dom", "react-dom/*"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find((f) => f.path.endsWith(".js")).text,
    { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), process: { env: {} } });
  return evaluated.exports.render;
}
const render = await renderer();

for (const language of ["ru", "en"]) for (const visible of [false, true]) {
  test(`participants dock follows source visibility: ${language}, visible ${visible}`, () => {
    const source = createParticipantsSource({ requestRoom: async () => ({ peers: "[]" }), getSession: () => "s:1",
      getLanguage: () => language, getCapabilities: () => ({ visible }), execute: async () => ({}) });
    const html = render({ source });
    assert.equal(/<aside[^>]* hidden=""/.test(html), !visible);
    assert.match(html, new RegExp(`aria-label="${language === "en" ? "Participants" : "Участники"}"`));
    assert.equal((html.match(/<h2/g) || []).length <= 1, true, "no duplicate dock heading");
    assert.doesNotMatch(html, /<slot|shadowroot|participantsList|plist/);
    source.dispose();
  });
}

for (const [name, capability, expected] of [["open", true, true], ["closed", false, false], ["missing", undefined, false], ["truthy non-boolean", "yes", false]]) {
  test(`participants visibility capability is strictly boolean: ${name}`, () => {
    const source = createParticipantsSource({ requestRoom: async () => ({ peers: "[]" }), getSession: () => "s:1",
      getLanguage: () => "ru", getCapabilities: () => ({ visible: capability }), execute: async () => ({}) });
    assert.equal(source.getSnapshot().visible, expected);
    source.dispose();
  });
}

test("close is an allowlisted participant command delegated to the retained owner", async () => {
  const commands = [];
  const source = createParticipantsSource({ requestRoom: async () => ({ peers: "[]" }), getSession: () => "s:1",
    getLanguage: () => "ru", execute: async (command) => { commands.push(command.type); return {}; } });
  await source.execute({ type: "close" });
  await assert.rejects(source.execute({ type: "closeEverything" }), /Invalid participant command/);
  assert.deepEqual(commands, ["close"]);
  source.dispose();
});
