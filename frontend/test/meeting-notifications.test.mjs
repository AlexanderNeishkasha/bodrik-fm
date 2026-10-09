import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const result = await build({
  stdin: { contents: 'import React from "react"; import {renderToStaticMarkup} from "react-dom/server"; import View from "./features/meeting/MeetingNotifications.js"; export const render = props => renderToStaticMarkup(React.createElement(View, props));',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
  bundle: true, format: "cjs", platform: "node", write: false, outdir: "out", jsx: "automatic",
  loader: { ".js": "jsx", ".css": "empty" }, external: ["react", "react/*", "react-dom", "react-dom/*"],
});
const evaluated = { exports: {} };
vm.runInNewContext(result.outputFiles.find((file) => file.path.endsWith(".js")).text, {
  module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), process: { env: {} },
});
for (const scenario of [
  { name: "quiet source", snapshot: null, expected: "" },
  { name: "informational text", snapshot: { text: "Ready", severity: "info" }, role: "status" },
  { name: "error announcement", snapshot: { text: "Failed", severity: "error" }, role: "alert" },
  { name: "untrusted text escaped", snapshot: { text: '<img src=x onerror="alert(1)">', severity: "warning" }, role: "status" },
]) {
  test(`shared meeting notification: ${scenario.name}`, () => {
    const html = evaluated.exports.render({ source: { getSnapshot: () => scenario.snapshot,
      subscribe() { throw new Error("Static rendering cannot subscribe"); } },
      onReady() { throw new Error("Static rendering cannot retire views or play sounds"); } });
    if (scenario.expected === "") assert.equal(html, "");
    else {
      assert.match(html, new RegExp(`role="${scenario.role}"`));
      assert.match(html, /panel-shadow-toast/);
      assert.doesNotMatch(html, /<img|<audio|swal2/);
    }
  });
}
