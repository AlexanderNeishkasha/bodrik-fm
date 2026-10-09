import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ABOUT_COPY, normalizeAboutSnapshot, SOURCE_REPOSITORY_URL } from "../features/meeting/about/aboutModel.mjs";

test("About ignores obsolete fork metadata", () => {
  assert.equal(normalizeAboutSnapshot({ sourceRevision: "a".repeat(40) }).sourceUrl, undefined);
});

test("About snapshot is bounded, read-only metadata and language falls back to Russian", () => {
  const model = normalizeAboutSnapshot({ language: "invalid", version: "x".repeat(100), token: "secret" });
  assert.equal(model.language, "ru");
  assert.equal(model.version.length, 64);
  assert.equal(model.token, undefined);
});

/** Compile the actual shared component for static render assertions; effects remain browser-only. */
async function renderer() {
  const result = await build({
    stdin: {
      contents: 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import AboutDialog from "./features/meeting/about/AboutDialog.js"; export const render = (snapshot) => renderToStaticMarkup(React.createElement(AboutDialog, { snapshot, onClose() {} }));',
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    },
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
    outdir: "unused-about-test-output",
    loader: { ".js": "jsx" }, external: ["react", "react/*", "react-dom/*"],
    define: { "process.env.NEXT_PUBLIC_ASSET_PREFIX": '""' },
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find((file) => file.path.endsWith(".js")).text, { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url) });
  return evaluated.exports.render;
}

for (const language of ["ru", "en"]) {
  test(`shared About component renders safe localized content: ${language}`, async () => {
    const render = await renderer();
    const html = render({ language, version: '<script>alert("x")</script>', sourceRevision: "a".repeat(40) });
    assert.ok(html.includes(ABOUT_COPY[language].title));
    assert.ok(html.includes("AGPL-3.0"));
    assert.ok(html.includes('rel="noopener noreferrer"'));
    assert.equal((html.match(/<svg /g) || []).length, 5);
    assert.equal((html.match(/aria-hidden="true"/g) || []).length, 5);
    assert.ok(html.includes('viewBox="0 0 24 24"'));
    assert.ok(html.includes('/meeting-assets/LICENSE'));
    assert.ok(html.includes(`href="${SOURCE_REPOSITORY_URL}"`));
    assert.ok(html.includes(ABOUT_COPY[language].sourceLink));
    assert.equal(html.includes('publicly available'), false);
    assert.equal(html.includes('<script>'), false);
  });
}
