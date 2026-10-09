import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { MEETING_THEMES } from "../features/meeting/client/theme.mjs";

/** Render the real chat workspace/CSS in isolation, without joining a room or sending messages. */
export async function chatColorFixture() {
  const result = await build({
    stdin: { contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import ChatWorkspace from "./features/meeting/chat/ChatWorkspace.js";
      import theme from "./features/meeting/meetingTheme.module.css";
      const messages = ["incoming", "outgoing"].map((direction, key) => ({
        key, direction, messageId: String(key), peerId: "fixture", name: "Chat preview",
        targetId: "all", body: "Hello / Привет — readable chat text", receivedAt: 1000, reactions: [],
      }));
      const snapshot = { selected: "all", unread: 0, conversations: [{ id: "all", name: "", unread: 0 }], messages };
      const source = { getSnapshot: () => snapshot, subscribe: () => () => {} };
      export const html = renderToStaticMarkup(React.createElement("main", { className: theme.theme },
        React.createElement(ChatWorkspace, { source, origin: "https://fixture.invalid", language: "en", nativeNavigation: true, nativeToolbar: true })));
    `, resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
    outdir: "unused-chat-color-output", loader: { ".js": "jsx" },
    external: ["react", "react/*", "react-dom", "react-dom/*", "next/image"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find(file => file.path.endsWith(".js")).text,
    { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), URL });
  const themes = MEETING_THEMES.map(theme => readFileSync(new URL(`../app/themes/${theme}.css`, import.meta.url), "utf8")).join("\n");
  const css = result.outputFiles.find(file => file.path.endsWith(".css")).text;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${themes}\n${css}
    body { margin: 0; padding: 20px; background: var(--theme-bg); font: 16px/1.5 system-ui; }
    main { max-width: 440px; height: 600px; margin: auto; background: var(--theme-card); border-radius: 28px; }
  </style></head><body>${evaluated.exports.html}</body></html>`;
}
