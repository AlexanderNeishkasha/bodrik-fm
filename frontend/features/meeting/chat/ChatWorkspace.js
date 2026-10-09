"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import styles from "./ChatWorkspace.module.css";
import ChatComposer from "./ChatComposer";
import ChatTranscript from "./ChatTranscript";

/** Chat history and composer for the panel; the conversation selector lives in the panel header. */
export default function ChatWorkspace({ source, origin, language = "ru", submit, onReady }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  language = snapshot.language || language;
  const history = useRef(null);
  const composer = useRef(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const followBottom = useRef(true);
  const scrollSession = useRef(snapshot.sessionKey);
  const lastKey = snapshot.messages.filter((item) => (item.targetId === "all" ? "all" : item.direction === "outgoing" ? item.targetId : item.peerId) === snapshot.selected).at(-1)?.key;
  useEffect(() => { onReady?.(); }, [onReady]);
  useEffect(() => {
    const pane = history.current;
    if (!pane) return;
    if (scrollSession.current !== snapshot.sessionKey || snapshot.selected !== "all") followBottom.current = true;
    scrollSession.current = snapshot.sessionKey;
    /** Keep the bottom visible after image decoding or composer preview removal changes content/viewport height. */
    function scrollToEnd() {
      if (followBottom.current) pane.scrollTop = pane.scrollHeight;
    }
    scrollToEnd();
    const observer = new ResizeObserver(scrollToEnd);
    observer.observe(pane);
    if (pane.firstElementChild) observer.observe(pane.firstElementChild);
    return () => observer.disconnect();
  }, [snapshot.sessionKey, snapshot.selected, lastKey]);
  /** Reset nested drag tracking after leaving the chat or finishing a drop. */
  function clearDrag() { dragDepth.current = 0; setDragging(false); }

  return <div className={styles.workspace} data-chat-drop-zone=""
    onDragEnter={(event) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      dragDepth.current++;
      if (composer.current?.canAttach()) setDragging(true);
    }}
    onDragOver={(event) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = composer.current?.canAttach() ? "copy" : "none";
    }}
    onDragLeave={() => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    }}
    onDrop={(event) => {
      if (!Array.from(event.dataTransfer.types).includes("Files") && !event.dataTransfer.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      clearDrag();
      composer.current?.attachFiles(event.dataTransfer.files);
    }}>
    {dragging && <div className={styles.dropOverlay} role="status"><span>{language === "en" ? "Drop a file or image here" : "Перетащите сюда файл или изображение"}</span></div>}
    <div ref={history} className={styles.history}
      onWheel={(event) => {
        const pane = history.current;
        if (pane && (event.deltaY < 0 || pane.scrollHeight - pane.scrollTop - pane.clientHeight > 32)) followBottom.current = false;
      }}
      onTouchMove={() => { followBottom.current = false; }}
      onPointerDown={(event) => {
        const pane = history.current;
        if (pane && event.clientX >= pane.getBoundingClientRect().right - (pane.offsetWidth - pane.clientWidth)) followBottom.current = false;
      }}
      onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) followBottom.current = false; }}
      onScroll={async () => {
        const pane = history.current;
        if (pane && pane.scrollTop < 40 && snapshot.selected === "all" && snapshot.hasMore && !snapshot.historyLoading) {
          const height = pane.scrollHeight; const offset = pane.scrollTop;
          followBottom.current = false;
          await source.loadOlder?.();
          requestAnimationFrame(() => {
            const current = source.getSnapshot();
            if (history.current === pane && current.sessionKey === snapshot.sessionKey && current.selected === "all") pane.scrollTop = offset + pane.scrollHeight - height;
          });
        }
        // Scroll anchoring/resizing may emit scroll events: only explicit user intent leaves bottom-follow mode.
        if (pane && !followBottom.current && pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 32) followBottom.current = true;
      }}><div>{snapshot.selected === "all" && (snapshot.historyLoading || snapshot.historyError) && <div role="status">
        {snapshot.historyLoading ? language === "en" ? "Loading…" : "Загрузка…" : <button type="button" onClick={() => source.loadOlder?.()}>{language === "en" ? "Retry loading history" : "Загрузить историю снова"}</button>}
      </div>}<ChatTranscript key={snapshot.sessionKey} source={source} origin={origin} language={language} /></div></div>
    {submit && <ChatComposer ref={composer} key={`${snapshot.sessionKey}:${snapshot.selected}`} submit={(body, options) => submit({ body, targetId: snapshot.selected }, options)}
      language={language} disabled={snapshot.canSend === false || snapshot.available === false} />}
  </div>;
}
