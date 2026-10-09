import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { projectChatContent } from "../features/meeting/chat/chatContent.mjs";

const origin = "https://meeting.invalid";
const image = `${origin}/uploads/chat/0123-abcd.webp`;

for (const extension of ["png", "jpg", "webp"]) {
  test(`chat recognizes retained same-origin ${extension} upload and preserves plain caption`, () => {
    const body = `${origin}/uploads/chat/abcd-0123.${extension}\ncaption\n<img src=x>`;
    const content = projectChatContent(body, origin);
    assert.equal(content.type, "uploaded-image");
    assert.equal(content.caption, "caption\n<img src=x>");
    assert.equal(Object.isFrozen(content), true);
  });
}
for (const [name, body] of [
  ["foreign host", "https://foreign.invalid/uploads/chat/abcd.png"],
  ["origin prefix confusion", "https://meeting.invalid.attacker/uploads/chat/abcd.png"],
  ["foreign scheme", "http://meeting.invalid/uploads/chat/abcd.png"],
  ["protocol relative", "//meeting.invalid/uploads/chat/abcd.png"],
  ["relative URL", "/uploads/chat/abcd.png"],
  ["data URL", "data:image/png;base64,abcd"],
  ["script URL", "javascript:alert(1)"],
  ["encoded traversal", `${origin}/uploads/chat/%2e%2e/abcd.png`],
  ["literal traversal", `${origin}/uploads/chat/../abcd.png`],
  ["nested directory", `${origin}/uploads/chat/nested/abcd.png`],
  ["query", `${image}?token=synthetic`],
  ["fragment", `${image}#fragment`],
  ["unsupported extension", `${origin}/uploads/chat/abcd.svg`],
  ["HTML wrapper", `<img src="${image}" onerror="unsafe()">`],
  ["markdown wrapper", `![image](${image})`],
  ["carriage return", `${image}\r\ncaption`],
  ["oversized filename", `${origin}/uploads/chat/${"a".repeat(161)}.png`],
]) {
  test(`chat keeps ${name} literal; it never becomes an image request`, () => {
    assert.deepEqual(projectChatContent(body, origin), { type: "text", text: body });
  });
}
for (const [name, value] of [["missing", undefined], ["opaque", "null"], ["credentials", "https://user:password@meeting.invalid"], ["path", `${origin}/meeting`], ["query", `${origin}?key=synthetic`], ["fragment", `${origin}#x`], ["file scheme", "file:///tmp/"]]) {
  test(`chat never infers uploaded-image origin from ${name} origin`, () => assert.equal(projectChatContent(image, value).type, "text"));
}
test("chat projection bounds content and retains whitespace/entities without interpreting them", () => {
  assert.equal(projectChatContent("x".repeat(4000), origin).text.length, 4000);
  for (const body of [null, "", " ", "x".repeat(4001)]) assert.throws(() => projectChatContent(body, origin), /Invalid chat/);
  assert.equal(projectChatContent("&lt;script&gt;\n```js\nunsafe()\n```", origin).type, "text");
  assert.equal(projectChatContent(image, origin).caption, "");
});

/** Compile actual JSX with real React SSR; no DOM, window, transport or network API is supplied. */
async function renderer() {
  const result = await build({
    stdin: { contents: 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import View from "./features/meeting/chat/ChatMessageContent.js"; export const render = props => renderToStaticMarkup(React.createElement(View, props));', resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
    outdir: "unused-chat-content-test-output", loader: { ".js": "jsx" },
    external: ["react", "react/*", "react-dom", "react-dom/*", "next/image"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find((file) => file.path.endsWith(".js")).text, { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), URL });
  return evaluated.exports.render;
}
test("actual content renderer escapes HTML, markdown, entities and malicious URLs without HTML sinks", async () => {
  const render = await renderer();
  for (const body of ['<script>unsafe()</script>', '<img src=x onerror="unsafe()">', '[link](javascript:unsafe())', '&lt;script&gt;']) {
    const html = render({ body, origin });
    assert.equal(/<(script|img|a)\b/.test(html), false);
    assert.equal(html.includes(' onerror="'), false);
  }
});
for (const language of ["ru", "en"]) {
  test(`actual uploaded-image renderer has escaped caption and localized accessible alt: ${language}`, async () => {
    const render = await renderer();
    const html = render({ body: `${image}\n<img src=x onerror="unsafe()">`, origin, language });
    assert.equal((html.match(/<img\b/g) || []).length, 1);
    assert.ok(html.includes('loading="lazy"'));
    assert.ok(html.includes('referrerPolicy="no-referrer"') || html.includes('referrerpolicy="no-referrer"'));
    assert.ok(html.includes("&lt;img"));
    assert.ok(html.includes(language === "en" ? "Shared meeting image" : "Изображение в чате"));
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes('rel="preload"'), false);
  });
}
