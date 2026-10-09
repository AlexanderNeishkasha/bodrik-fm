"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

/** Render authenticated raster bytes at their natural size; static export bypasses the image optimizer.
 * Zero dimension hints plus CSS auto sizing leave unknown blob dimensions to the browser.
 * Abort obsolete reads and revoke their object URLs.
 */
export default function ChatPersistentImage({ attachment, source, language }) {
  const element = useRef(null);
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = null;
    /** Begin the owned read only when the image enters the clipped chat viewport. */
    function load(entries) {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      source.attachmentBlob(attachment.id, { signal: controller.signal }).then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    }
    const observer = new IntersectionObserver(load, { rootMargin: "80px" });
    observer.observe(element.current);
    return () => { observer.disconnect(); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment.id, source]);
  if (failed) return <span role="status">{language === "en" ? "Image unavailable" : "Изображение недоступно"}</span>;
  if (!url) return <div ref={element} role="status" style={{ minHeight: 140 }}>{language === "en" ? "Loading image…" : "Загрузка изображения…"}</div>;
  return <Image unoptimized width={0} height={0} src={url} alt={attachment.name} loading="lazy" style={{ width: "auto", height: "auto", display: "block", maxWidth: "100%", maxHeight: 360, borderRadius: 12 }} />;
}
