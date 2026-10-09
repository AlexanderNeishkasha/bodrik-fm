import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** Render actual chat JSX and icons with React SSR; transport actions must never run during rendering. */
async function renderer() {
  const built = await build({ stdin: { contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import View from "./features/meeting/chat/ChatWorkspace.js";
    const command = () => { throw new Error("No render-time command"); };
    export const render = snapshot => renderToStaticMarkup(React.createElement(View, { source: { getSnapshot: () => snapshot, subscribe: () => () => {}, react: command, copy: command, remove: command, getAvatar: () => "/uploads/avatars/abcd.webp" }, origin: "https://meeting.invalid", language: "ru", nativeNavigation: true, nativeToolbar: true, submit: command }));`, resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic", outdir: "unused-chat-visual-output", loader: { ".js": "jsx" }, external: ["react", "react/*", "react-dom", "react-dom/*", "next/image"] });
  const evaluated = { exports: {} };
  vm.runInNewContext(built.outputFiles.find((file) => file.path.endsWith(".js")).text, { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), URL });
  return evaluated.exports.render;
}
for (const direction of ["incoming", "outgoing"]) {
  test(`live ${direction} renderer retains bubble/avatar/icon layout without duplicate visible controls`, async () => {
    const render = await renderer();
    const html = render({ selected: "all", unread: 0, conversations: [{ id: "all", name: "", unread: 0 }], messages: [{ key: 1, messageId: "fixture", peerId: "peer", name: "Никс", targetId: "all", body: "Тест", direction, receivedAt: 1000, reactions: [] }] });
    assert.ok(html.includes(direction));
    assert.ok(html.includes('src="https://meeting.invalid/uploads/avatars/abcd.webp"'));
    // Only the author (or the presenter) can delete a message.
    assert.equal(html.includes('aria-label="Действия с сообщением"'), direction === "outgoing");
    assert.equal(html.includes('aria-label="Копировать"'), false);
    assert.equal(html.includes('aria-label="Реакция"'), false);
    assert.ok(html.includes('aria-label="Отправить"'));
    assert.ok(html.includes('<svg'));
    assert.ok(html.includes('placeholder="Введите сообщение…"'));
    assert.ok(html.includes('0 / 4000'));
    assert.ok(html.includes('Shift+Enter'));
    assert.equal(html.includes('<select'), false);
    assert.equal(html.includes('Отправлено локально'), false);
    assert.equal(html.includes('доставка не подтверждена'), false);
    assert.equal(html.includes('Browse'), false);
    assert.equal(html.includes('>Копировать</button>'), false);
  });
}

test("presenter can delete incoming messages", async () => {
  const render = await renderer();
  const html = render({ selected: "all", unread: 0, canModerate: true, conversations: [{ id: "all", name: "", unread: 0 }], messages: [{ key: 1, messageId: "fixture", peerId: "peer", name: "Никс", targetId: "all", body: "Тест", direction: "incoming", receivedAt: 1000, reactions: [] }] });
  assert.ok(html.includes('aria-label="Действия с сообщением"'));
});
