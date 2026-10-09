import { CHAT_LIMITS } from "./chatEvents.mjs";

/** Normalize an explicitly injected meeting origin; no window, network or authorization inference. */
function meetingOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

/** Project retained upload syntax only; all other legacy markup remains literal text until formatting parity is implemented. */
export function projectChatContent(body, origin) {
  if (typeof body !== "string" || !body.trim() || body.length > CHAT_LIMITS.body) throw new TypeError("Invalid chat content body");
  const canonical = meetingOrigin(origin);
  const newline = body.indexOf("\n");
  const firstLine = newline < 0 ? body : body.slice(0, newline);
  const prefix = canonical && `${canonical}/uploads/chat/`;
  if (prefix && firstLine.startsWith(prefix)) {
    const filename = firstLine.slice(prefix.length);
    if (filename.length <= CHAT_LIMITS.id && /^[0-9a-f-]+\.(png|jpg|webp)$/.test(filename)) {
      return Object.freeze({ type: "uploaded-image", src: firstLine, caption: newline < 0 ? "" : body.slice(newline + 1) });
    }
  }
  return Object.freeze({ type: "text", text: body });
}
