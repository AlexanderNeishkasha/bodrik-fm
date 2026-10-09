import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { attachmentSize, CHAT_FILE_BYTES, validAttachment } from "../features/meeting/chat/chatAttachment.mjs";

for (const [name, file, accepted] of [
  ["document", { name: "rules.pdf", size: 1024, type: "application/pdf" }, true],
  ["image", { name: "photo.png", size: 1024, type: "image/png" }, true],
  ["large image", { name: "photo.png", size: 5 * 1024 * 1024 + 1, type: "image/png" }, false],
  ["size boundary", { name: "rules.pdf", size: CHAT_FILE_BYTES }, true],
  ["too large", { name: "rules.pdf", size: CHAT_FILE_BYTES + 1 }, false],
  ["empty", { name: "rules.pdf", size: 0 }, false],
  ["path", { name: "../rules.pdf", size: 1 }, false],
  ["control character", { name: "rules\n.pdf", size: 1 }, false],
]) test(`attachment validation: ${name}`, () => assert.equal(validAttachment(file), accepted));

test("attachment sizes use localized numbers and units", () => {
  assert.equal(attachmentSize(100, "ru"), "100 Б");
  assert.equal(attachmentSize(1536, "ru"), "1,5 КБ");
  assert.equal(attachmentSize(1536, "en"), "1.5 KB");
  assert.equal(attachmentSize(1024 * 1024, "en"), "1 MB");
  assert.equal(attachmentSize(undefined), "");
});

/** Render the actual document bubble without opening files or retaining payloads. */
async function renderer() {
  const result = await build({
    stdin: { contents: 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import View from "./features/meeting/chat/ChatFileAttachment.js"; export const render = attachment => renderToStaticMarkup(React.createElement(View, { attachment, source: {}, language: "ru" }));', resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, platform: "node", format: "cjs", write: false, outdir: "unused", jsx: "automatic",
    loader: { ".js": "jsx", ".css": "empty" }, external: ["react", "react/*", "react-dom", "react-dom/*"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find((file) => file.path.endsWith(".js")).text, { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), Intl });
  return evaluated.exports.render;
}

for (const [phase, downloadable, expected] of [
  ["transferring", false, "Передача…"], ["failed", false, "Не удалось передать файл"],
  ["cancelled", false, "Передача отменена"], ["completed", false, "Файл больше недоступен"],
  ["completed", true, "Скачать"],
]) test(`document bubble: ${phase}, downloadable ${downloadable}`, async () => {
  const render = await renderer();
  const html = render({ id: "id", name: "<Rules>.pdf", size: 1536, transferred: 512, phase, downloadable });
  assert.match(html, /&lt;Rules&gt;\.pdf/);
  assert.match(html, /1,5 КБ/);
  assert.ok(html.includes(expected));
  assert.equal(html.includes("<progress"), phase === "transferring");
  assert.equal(html.includes("disabled"), !downloadable);
  assert.doesNotMatch(html, /<iframe|<object|<embed/);
});
