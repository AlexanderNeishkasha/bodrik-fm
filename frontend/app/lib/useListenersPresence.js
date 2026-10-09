import { useEffect, useRef } from "react";

export default function useListenersPresence({ apiBase, enabled }) {
  const listenerWsRef = useRef(null);
  const listenerWsRetryRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const clearRetry = () => {
      if (listenerWsRetryRef.current) {
        clearTimeout(listenerWsRetryRef.current);
        listenerWsRetryRef.current = null;
      }
    };
    const closeSocket = () => {
      if (listenerWsRef.current) {
        listenerWsRef.current.close();
        listenerWsRef.current = null;
      }
    };
    if (!enabled) {
      clearRetry();
      closeSocket();
      return;
    }
    const connect = () => {
      if (cancelled || !enabled) {
        return;
      }
      if (
        listenerWsRef.current &&
        (listenerWsRef.current.readyState === WebSocket.OPEN ||
          listenerWsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      const base = apiBase || window.location.origin;
      const url = new URL(base);
      const protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${url.host}/ws/listeners`;
      const ws = new WebSocket(wsUrl);
      listenerWsRef.current = ws;
      ws.onclose = () => {
        if (listenerWsRef.current === ws) {
          listenerWsRef.current = null;
        }
        if (cancelled || !enabled) {
          return;
        }
        clearRetry();
        listenerWsRetryRef.current = setTimeout(connect, 1500);
      };
      ws.onerror = () => {
        ws.close();
      };
    };
    connect();
    return () => {
      cancelled = true;
      clearRetry();
      closeSocket();
    };
  }, [apiBase, enabled]);
}
