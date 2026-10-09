import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** Compile the real meeting grid for static-import and markup checks without browser resources. */
async function renderer() {
  const compiled = await build({
    stdin: {
      contents: 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import View from "./features/meeting/room/MeetingGrid.js"; import { createLayout } from "./features/meeting/client/layout.mjs"; export const render = snapshot => renderToStaticMarkup(React.createElement(View, { selfId: "", layout: createLayout(), registry: { getSnapshot: () => snapshot, subscribe: () => () => {}, getTrack: () => null } }));',
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    },
    bundle: true, format: "cjs", platform: "node", write: false, outdir: "out",
    jsx: "automatic", loader: { ".js": "jsx", ".css": "empty" },
    define: { "process.env.NEXT_PUBLIC_ASSET_PREFIX": JSON.stringify("") },
    external: ["react", "react/*", "react-dom", "react-dom/*"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(compiled.outputFiles.find((file) => file.path.endsWith(".js")).text, {
    module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url),
  });
  return evaluated.exports.render;
}

const render = await renderer();
for (const [name, participant, sources, expected] of [
  ["camera off", { id: "alice", name: "Alice" }, [], /AL/],
  ["uploaded avatar", { id: "alice", name: "Alice", avatar: "/uploads/avatars/alice.webp" }, [], /href="\/uploads\/avatars\/alice\.webp"/],
  ["presenter", { id: "alice", name: "Alice", presenter: true }, [], /Ведущий/],
  // The sticky server dominant-speaker flag no longer highlights; live audio levels do.
  ["stale server speaker", { id: "alice", name: "Alice", speaking: true }, [], /^(?![\s\S]*data-speaking)/],
  ["microphone on", { id: "alice", name: "Alice", audio: true }, [], /Микрофон включён/],
  ["microphone off", { id: "alice", name: "Alice", audio: false }, [], /Микрофон выключен/],
  ["music", { id: "alice", name: "Bot", bot: true }, [{ id: "music", participantId: "alice", kind: "audio" }], /href="\/images\/bodrik-ava\.png"/],
  ["camera", { id: "alice", name: "Alice" }, [{ id: "camera", participantId: "alice", kind: "camera", local: true }], /<video[^>]*muted=""/],
  ["screen", { id: "alice", name: "Alice" }, [{ id: "screen", participantId: "alice", kind: "screen" }], /<video/],
  ["paused camera", { id: "alice", name: "Alice" }, [{ id: "camera", participantId: "alice", kind: "camera", paused: true }], /<svg/],
]) {
  test(`media registry static rendering: ${name}`, () => {
    const html = render({ participants: [participant], sources, trackRevision: 0 });
    assert.match(html, expected);
    assert.doesNotMatch(html, /<audio|<iframe|sessionId|consumerId/);
    if (name === "paused camera") assert.doesNotMatch(html, /<video/);
  });
}

test("participant names remain text and removed participants leave no cards", () => {
  const html = render({ participants: [{ id: "alice", name: "<script>alert(1)</script>" }], sources: [], trackRevision: 0 });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(render({ participants: [], sources: [], trackRevision: 0 }), /data-participant-id/);
});
