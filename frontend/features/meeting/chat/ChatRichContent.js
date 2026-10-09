"use client";

import { useState } from "react";
import Image from "next/image";
import { projectRichChatContent } from "./chatRichContent.mjs";
import { projectChatContent } from "./chatContent.mjs";
import styles from "./ChatMessageContent.module.css";

/** Render accepted images with bounded natural sizing, explicit external consent and load failures.
 * Static export uses direct URLs; CSS auto sizing overrides unknown dimension hints.
 */
export function ChatImage({ src, origin, alt, language = "ru" }) {
  const uploaded = projectChatContent(src, origin).type === "uploaded-image";
  const [load, setLoad] = useState(uploaded);
  const [failed, setFailed] = useState(false);
  const english = language === "en";
  return <span>
    {!load && <button type="button" onClick={() => setLoad(true)}>{english ? "Load external image" : "Загрузить внешнее изображение"}</button>}
    {load && !failed && <a href={src} target="_blank" rel="noopener noreferrer"><Image unoptimized width={0} height={0} style={{ width: "auto", height: "auto" }} className={styles.image} src={src}
      alt={alt || (english ? "Shared meeting image" : "Изображение в чате")} loading="lazy" decoding="async"
      referrerPolicy="no-referrer" onError={() => setFailed(true)} /></a>}
    {failed && <span role="status">{english ? "Image unavailable" : "Изображение недоступно"} <a href={src} target="_blank" rel="noopener noreferrer">{english ? "Open image" : "Открыть изображение"}</a></span>}
  </span>;
}

/** Render allowlisted nodes through React escaping; no HTML/attribute/event sink is used. */
function nodeView(node, index, origin, language) {
  if (node.text !== undefined) return node.text;
  if (node.tag === "img") return <ChatImage key={index} src={node.url} origin={origin} alt={node.alt} language={language} />;
  const Tag = node.tag;
  const props = node.tag === "a" ? { href: node.url, target: "_blank", rel: "noopener noreferrer" } :
    node.tag === "code" && node.language ? { className: `language-${node.language}` } : {};
  if (["br", "hr"].includes(node.tag)) return <Tag key={index} />;
  return <Tag key={index} {...props}>{node.children.map((child, childIndex) => nodeView(child, childIndex, origin, language))}</Tag>;
}

/** Render retained formatted HTML and fenced code; raw Markdown is formatted by the existing sender, not reparsed here. */
export default function ChatRichContent({ body, origin, language }) {
  const nodes = projectRichChatContent(body, origin);
  return <div className={styles.rich}>{nodes.map((node, index) => nodeView(node, index, origin, language))}</div>;
}
