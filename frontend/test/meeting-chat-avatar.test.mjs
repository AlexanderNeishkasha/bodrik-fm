import test from "node:test";
import assert from "node:assert/strict";
import { safeChatAvatar } from "../features/meeting/chat/chatAvatar.mjs";

const origin = "https://meeting.invalid";
for (const value of ["/uploads/avatars/abcd.webp", `${origin}/uploads/avatars/account/abcd.png`]) {
  test(`chat avatar accepts public same-origin upload: ${value}`, () => assert.ok(safeChatAvatar(value, origin).startsWith(origin)));
}
for (const [name, value] of [["remote", "https://foreign.invalid/uploads/avatars/abcd.png"], ["data", "data:image/svg+xml,unsafe"], ["blob", "blob:private"], ["credentials", "https://user:pass@meeting.invalid/uploads/avatars/abcd.png"], ["query", `${origin}/uploads/avatars/abcd.png?token=private`], ["wrong directory", "/uploads/chat/abcd.png"], ["SVG", "/uploads/avatars/abcd.svg"], ["traversal", "/uploads/avatars/../../private.png"], ["oversized", "x".repeat(1025)], ["nonstring", {}]]) {
  test(`chat avatar rejects ${name} rather than issuing an untrusted request`, () => assert.equal(safeChatAvatar(value, origin), ""));
}
