/** Supported retained formatting tags; all other tags remain inert literal text. */
const TAGS = new Set(["p", "div", "span", "br", "hr", "strong", "b", "em", "i", "s", "del", "u", "pre", "code", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "a", "img"]);
/** Decode text entities without invoking a DOM HTML parser or connecting resource elements. */
function entities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, value) => {
    if (!value.startsWith("#")) return named[value.toLowerCase()] || all;
    const number = value[1].toLowerCase() === "x" ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : all;
  });
}
/** Allow HTTP(S) destinations only; credentials, control characters and executable schemes are never rendered. */
export function safeChatUrl(value, origin) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value, origin);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
/** Extract one retained attribute; duplicate attributes are rejected rather than guessing browser precedence. */
function attribute(text, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi");
  const matches = [...text.matchAll(pattern)];
  return matches.length === 1 ? entities(matches[0][1] ?? matches[0][2] ?? matches[0][3]) : null;
}
/** Freeze a bounded render tree after parsing; no input HTML is ever passed to a React HTML sink. */
function freeze(node) {
  if (node.children) node.children = Object.freeze(node.children.map(freeze));
  return Object.freeze(node);
}
/** Project formatted retained HTML/code fences into a small allowlisted tree; malformed/unsupported markup remains text. */
export function projectRichChatContent(body, origin) {
  if (typeof body !== "string" || body.length > 4000 || !body.trim()) throw new TypeError("Invalid rich chat body");
  const root = { tag: "root", children: [] };
  const stack = [root];
  let count = 0;
  /** Append escaped text without interpreting attributes or resource URLs. */
  function text(value) { stack.at(-1).children.push({ text: entities(value) }); }
  for (const token of body.match(/```[^\n]*\n[\s\S]*?```|<[^>]*>|[^<]+|</g) || []) {
    if (++count > 512) return Object.freeze([Object.freeze({ text: body })]);
    const fence = /^```([a-zA-Z0-9]*)\n([\s\S]*?)```$/.exec(token);
    if (fence) { stack.at(-1).children.push({ tag: "pre", children: [{ tag: "code", language: fence[1], children: [{ text: entities(fence[2]) }] }] }); continue; }
    const closing = /^<\/([a-z][a-z0-9]*)\s*>$/i.exec(token);
    if (closing) {
      if (stack.length > 1 && stack.at(-1).tag === closing[1].toLowerCase()) stack.pop(); else text(token);
      continue;
    }
    const opening = /^<([a-z][a-z0-9]*)(\s[^>]*|\s*\/?)>$/i.exec(token);
    if (!opening || !TAGS.has(opening[1].toLowerCase()) || stack.length >= 32) { text(token); continue; }
    const tag = opening[1].toLowerCase();
    const node = { tag, children: [] };
    if (tag === "a" || tag === "img") {
      const raw = attribute(opening[2], tag === "a" ? "href" : "src");
      const url = safeChatUrl(raw, origin);
      if (!url || (tag === "img" && !/\.(png|jpe?g|webp|gif|avif)$/i.test(new URL(url).pathname))) { text(token); continue; }
      node.url = url;
      if (tag === "img") node.alt = attribute(opening[2], "alt") || "";
    }
    if (tag === "code") {
      const language = attribute(opening[2], "class");
      if (/^language-[a-zA-Z0-9-]{1,32}$/.test(language || "")) node.language = language.slice(9);
    }
    stack.at(-1).children.push(node);
    if (!["br", "hr", "img"].includes(tag) && !token.endsWith("/>")) stack.push(node);
  }
  return Object.freeze(root.children.map(freeze));
}
