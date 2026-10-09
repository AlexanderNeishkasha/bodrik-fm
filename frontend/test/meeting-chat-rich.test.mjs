import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { projectRichChatContent, safeChatUrl } from "../features/meeting/chat/chatRichContent.mjs";

const origin = "https://meeting.invalid";
/** Flatten the allowlisted render tree for security assertions without a DOM parser. */
function nodes(tree) { return tree.flatMap((node) => [node, ...nodes(node.children || [])]); }

for (const tag of ["strong", "em", "p", "blockquote", "ul", "li", "pre", "code", "table", "tr", "td", "h3"]) {
  test(`retained formatting preserves ${tag} without arbitrary attributes`, () => {
    const result = projectRichChatContent(`<${tag} style="color:red" onclick="unsafe()">hello &amp; goodbye</${tag}>`, origin);
    assert.equal(result[0].tag, tag);
    assert.equal(result[0].children[0].text, "hello & goodbye");
    assert.equal(Object.isFrozen(result[0]), true);
    assert.equal(JSON.stringify(result).includes("onclick"), false);
    assert.equal(JSON.stringify(result).includes("color:red"), false);
  });
}
for (const url of ["javascript:unsafe()", "data:text/html,unsafe", "https://user:password@foreign.invalid/x", "java&#x73;cript:unsafe()", "https://foreign.invalid/\\x", "https://foreign.invalid/ x"]) {
  test(`rich links reject executable/credential/ambiguous URL: ${url}`, () => {
    assert.equal(nodes(projectRichChatContent(`<a href="${url}">text</a>`, origin)).some((node) => node.tag === "a"), false);
  });
}
for (const [name, html] of [["duplicate href", '<a href="https://safe.invalid" href="javascript:unsafe()">text</a>'], ["SVG", '<svg onload="unsafe()"><path /></svg>'], ["iframe", '<iframe src="https://foreign.invalid"></iframe>'], ["script", '<script>unsafe()</script>'], ["handler-only image", '<img src=x onerror="unsafe()">']]) {
  test(`rich renderer tree keeps ${name} inert`, () => {
    const result = nodes(projectRichChatContent(html, origin));
    assert.ok(result.every((node) => !["script", "svg", "iframe", "img", "a"].includes(node.tag)));
    assert.ok(result.some((node) => node.text));
  });
}
test("rich projection preserves safe links, code fences, entities and line breaks without evaluating code", () => {
  const tree = projectRichChatContent('<p><a href="/terms">terms</a><br/>line</p>```js\n<img src=x>\n```', origin);
  assert.equal(tree[0].children[0].url, `${origin}/terms`);
  assert.equal(tree[1].tag, "pre");
  assert.equal(tree[1].children[0].language, "js");
  assert.equal(tree[1].children[0].children[0].text, "<img src=x>\n");
  assert.equal(safeChatUrl("/terms", origin), `${origin}/terms`);
});
test("rich projection bounds input/nodes/nesting and keeps malformed markup as inert data", () => {
  for (const value of [null, "", " ", "x".repeat(4001)]) assert.throws(() => projectRichChatContent(value, origin), /Invalid rich/);
  const excessive = '<br>'.repeat(513);
  assert.deepEqual(projectRichChatContent(excessive, origin), [{ text: excessive }]);
  assert.ok(nodes(projectRichChatContent('<p>'.repeat(40) + 'deep' + '</p>'.repeat(40), origin)).some((node) => node.text?.includes("<p>")));
});

/** Render actual rich JSX with React SSR, supplying no network or HTML parser APIs. */
async function render(body) {
  const result = await build({
    stdin: { contents: 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import View from "./features/meeting/chat/ChatRichContent.js"; export const render = body => renderToStaticMarkup(React.createElement(View, { body, origin: "https://meeting.invalid", language: "en" }));', resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic", outdir: "unused-chat-rich-output",
    loader: { ".js": "jsx" }, external: ["react", "react/*", "react-dom", "react-dom/*", "next/image"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find((file) => file.path.endsWith(".js")).text, { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), URL });
  return evaluated.exports.render(body);
}
test("actual rich JSX renders safe formatting/code/links but no script, event or style sink", async () => {
  const html = await render('<strong onclick="unsafe()">bold</strong><a href="https://safe.invalid">link</a><script>unsafe()</script>```js\n<img src=x>\n```');
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('class="language-js"'));
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes('onclick="'), false);
  assert.equal(html.includes('<img src="x"'), false);
});
test("actual external image requires explicit consent; uploaded image is lazy and referrer-free", async () => {
  const external = await render('<img src="https://foreign.invalid/picture.png" onerror="unsafe()">');
  assert.ok(external.includes("Load external image"));
  assert.equal(external.includes("<img"), false);
  const uploaded = await render('<img src="https://meeting.invalid/uploads/chat/abcd.png" alt="Shared">');
  assert.equal((uploaded.match(/<img/g) || []).length, 1);
  assert.ok(uploaded.includes('loading="lazy"'));
  assert.ok(uploaded.includes('src="https://meeting.invalid/uploads/chat/abcd.png"'));
  assert.ok(uploaded.includes('width:auto;height:auto'));
  assert.equal(uploaded.includes('/_next/image'), false);
  assert.equal(uploaded.includes('srcSet='), false);
  assert.ok(uploaded.includes('referrerPolicy="no-referrer"') || uploaded.includes('referrerpolicy="no-referrer"'));
});
