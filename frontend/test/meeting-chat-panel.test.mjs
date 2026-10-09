import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

/** Compile the actual ordinary tree without any DOM, island, transport or media globals. */
async function renderer() {
  const result = await build({
    stdin: { contents: 'import React from "react"; import {renderToStaticMarkup} from "react-dom/server"; import Panel from "./features/meeting/chat/ChatPanel.js"; import Workspace from "./features/meeting/chat/ChatWorkspace.js"; export const render = props => renderToStaticMarkup(React.createElement(Panel, props)); export const renderWorkspace = props => renderToStaticMarkup(React.createElement(Workspace, props));',
      resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, format: "cjs", platform: "node", write: false, outdir: "out", jsx: "automatic",
    loader: { ".js": "jsx", ".css": "empty" }, external: ["react", "react/*", "react-dom", "react-dom/*", "next/image"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find((file) => file.path.endsWith(".js")).text, {
    module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), process: { env: {} },
  });
  return evaluated.exports;
}
const { render, renderWorkspace } = await renderer();
for (const language of ["ru", "en"]) for (const visible of [false, true]) {
  test(`normal chat panel renders localized source-derived visibility: ${language}, visible ${visible}`, () => {
    const snapshot = { language, visible, available: true, canSend: true, sessionKey: 12, messages: [],
      selected: "all", conversations: [{ id: "all", name: "", unread: 0, available: true }] };
    const source = { getSnapshot: () => snapshot,
      subscribe() { throw new Error("Static render cannot subscribe"); },
      submit() { throw new Error("Render cannot send"); },
      dispose() { throw new Error("View cannot dispose domain source"); } };
    const html = render({ source, origin: "https://meeting.test" });
    assert.match(html, /<aside/);
    assert.equal(/<aside[^>]* hidden=""/.test(html), !visible);
    assert.match(html, new RegExp(language === "en" ? "Close chat" : "Закрыть чат"));
    assert.doesNotMatch(html, language === "en" ? /Chat actions|Emoji|Save history/ : /Действия чата|Эмодзи|Сохранить историю/);
    assert.match(html, new RegExp(language === "en" ? "Attach file" : "Прикрепить файл"));
    assert.doesNotMatch(html, /<slot|iframe|shadowroot|chatHistory|chatMessage/);
  });
}

for (const language of ["ru", "en"]) {
  test(`chat panel exposes exactly one top-level heading: ${language}`, () => {
    const snapshot = { language, visible: true, available: true, canSend: true, sessionKey: 1, messages: [],
      selected: "all", conversations: [{ id: "all", name: "", unread: 0, available: true }] };
    const source = { getSnapshot: () => snapshot, subscribe() { throw new Error("no static subscribe"); }, submit() {} };
    const html = render({ source, origin: "https://meeting.test" });
    assert.equal((html.match(/<h2/g) || []).length, 1);
    assert.match(html, new RegExp(`<h3[^>]*>${language === "en" ? "Messages" : "Сообщения"}</h3>`));
  });
}
