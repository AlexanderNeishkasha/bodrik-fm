/** Accept public uploaded avatars from the meeting origin only; never fetch remote/data/blob URLs from message metadata. */
export function safeChatAvatar(value, origin) {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\u0000-\u0020\u007f\\]/.test(value)) return "";
  try {
    const base = new URL(origin);
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== base.origin || url.username || url.password || url.search || url.hash ||
      !/^\/uploads\/avatars\/[a-zA-Z0-9_/-]+\.(png|jpe?g|webp)$/.test(url.pathname)) return "";
    return url.href;
  } catch { return ""; }
}
