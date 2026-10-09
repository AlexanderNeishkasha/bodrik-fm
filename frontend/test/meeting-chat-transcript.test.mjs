import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createChatSource } from "../features/meeting/chat/chatModel.mjs";

/** Compile actual transcript JSX with React SSR; render-time commands and transport subscriptions are forbidden. */
async function renderer(component = "ChatTranscript") {
  const result = await build({
    stdin: { contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import View from "./features/meeting/chat/${component}.js"; export const render = (snapshot, language) => renderToStaticMarkup(React.createElement(View, { source: { getSnapshot: () => snapshot, subscribe: () => { throw new Error("SSR must not subscribe"); }, selectConversation: () => { throw new Error("Rendering must not select"); }, setVisible: () => { throw new Error("Rendering must not mark read"); } }, fence: {}, origin: "https://meeting.invalid", language }));`, resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic",
    outdir: "unused-chat-transcript-test-output", loader: { ".js": "jsx" },
    external: ["react", "react/*", "react-dom", "react-dom/*", "next/image"],
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(result.outputFiles.find((file) => file.path.endsWith(".js")).text, { module: evaluated, exports: evaluated.exports, require: createRequire(import.meta.url), URL });
  return evaluated.exports.render;
}

for (const [language, label] of [["en", "No messages yet"], ["ru", "Сообщений пока нет"], ["unsupported", "Сообщений пока нет"]]) {
  test(`empty chat transcript is localized and passive: ${language}`, async () => {
    const render = await renderer();
    const source = createChatSource();
    const html = render(source.getSnapshot(), language);
    assert.ok(html.includes(label));
    assert.ok(html.includes('aria-labelledby='));
    assert.ok(html.includes('<ol'));
    assert.equal(html.includes('<button'), false);
    assert.equal(html.includes('aria-live'), false);
  });
}
for (const language of ["en", "ru"]) {
  test(`conversation workspace shows the selected conversation only, without commands: ${language}`, async () => {
    const source = createChatSource();
    const fence = source.replaceSession({ roomId: "room", peerId: "local" });
    source.receiveMessage(fence, { room_id: "room", peer_id: "remote", peer_name: "<script>peer</script>", to_peer_id: "local", peer_msg: "private body", msg_id: "m" });
    const render = await renderer("ChatWorkspace");
    const html = render(source.getSnapshot(), language);
    assert.equal(html.includes("<select"), false, "the selector lives in the panel header");
    assert.equal(html.includes("private body"), false);
    source.selectConversation(fence, "remote");
    const selected = render(source.getSnapshot(), language);
    assert.ok(selected.includes("private body"));
    assert.equal(source.getSnapshot().unread, 1);
  });
}

for (const language of ["en", "ru"]) {
  test(`actual transcript escapes names and renders public/private content without exposing identities: ${language}`, async () => {
    const source = createChatSource();
    const fence = source.replaceSession({ roomId: "private-room-identity", peerId: "private-local-identity" });
    source.receiveMessage(fence, { room_id: "private-room-identity", peer_id: "private-sender-identity", peer_name: '<script>name</script>', to_peer_id: "all", peer_msg: '<img src=x onerror="unsafe()">', msg_id: "private-message-identity" });
    source.receiveMessage(fence, { room_id: "private-room-identity", peer_id: "private-sender-identity", peer_name: "Sender", to_peer_id: "private-local-identity", peer_msg: 'https://meeting.invalid/uploads/chat/abcd.png\n<svg>caption</svg>', msg_id: "private-message-2" });
    const snapshot = source.getSnapshot();
    const render = await renderer();
    const publicHtml = render(snapshot, language);
    source.selectConversation(fence, "private-sender-identity");
    const privateHtml = render(source.getSnapshot(), language);
    source.selectConversation(fence, "all");
    const html = publicHtml + privateHtml;
    assert.equal(publicHtml.includes("Shared meeting image"), false);
    assert.equal(privateHtml.includes("unsafe()"), false);
    assert.equal(snapshot.unread, 2);
    for (const identity of ["private-room-identity", "private-local-identity", "private-sender-identity", "private-message-identity", "private-reactor-identity"]) assert.equal(html.includes(identity), false);
    assert.ok(html.includes("&lt;script&gt;name"));
    assert.equal(html.includes("reactor"), false, "reactions are not rendered");
    assert.ok(html.includes("&lt;svg&gt;caption"));
    assert.equal((html.match(/<img\b/g) || []).length, 1);
    assert.equal(/<(script|svg|button)\b/.test(html), false);
    assert.ok(html.includes(language === "en" ? "Private message" : "Личное сообщение"));
    assert.ok(html.includes(language === "en" ? "Public chat" : "Общий чат"));
    assert.equal(html.includes(language === "en" ? 'aria-label="Reactions"' : 'aria-label="Реакции"'), false);
    source.setVisible(fence, true);
    source.selectConversation(fence, "private-sender-identity");
    assert.ok(render(source.getSnapshot(), language).includes(language === "en" ? "Unread: 0" : "Непрочитанные: 0"));
  });
}
