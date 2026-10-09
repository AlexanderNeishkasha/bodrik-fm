import { useEffect, useRef, useState } from "react";
import { applyTheme } from "../../lib/theme";

/** Receive room-scoped snapshots; stale connections cannot enable local audio. */
export default function useStudioState({ apiBase, asUserId, isAuthed, roomKey }) {
  const scope = `${apiBase}:${asUserId ?? "self"}:${isAuthed}:${roomKey}`;
  const [snapshot, setSnapshot] = useState({ scope, data: null, connected: false });
  const wsRef = useRef(null);
  useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;
    let retry;
    let deadline;
    /** Reconnect the room-state transport after a bounded delay. */
    const connect = () => {
      if (cancelled) return;
      let ws;
      try {
        const url = new URL(apiBase || window.location.origin);
        const wsUrl = new URL(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/ws/studio/state`);
        if (asUserId != null) wsUrl.searchParams.set("as", String(asUserId));
        ws = new WebSocket(wsUrl);
      } catch {
        console.error("Invalid Studio WebSocket configuration");
        return;
      }
      wsRef.current = ws;
      let lost = false;
      /** Mark state unavailable before waiting for a potentially slow close handshake. */
      const disconnected = () => {
        if (cancelled || lost || wsRef.current !== ws) return;
        lost = true;
        clearTimeout(deadline);
        setSnapshot((previous) => ({ scope, data: previous?.scope === scope ? previous.data : null, connected: false }));
        retry = setTimeout(connect, 1500);
      };
      /** A half-open socket is not evidence that the output mode is still local. */
      const armDeadline = () => {
        clearTimeout(deadline);
        deadline = setTimeout(() => { disconnected(); ws.close(); }, 4500);
      };
      armDeadline();
      ws.onmessage = (event) => {
        if (cancelled || lost || wsRef.current !== ws) return;
        try {
          const data = JSON.parse(event.data);
          if (typeof data?.is_playing !== "boolean" || !Number.isFinite(data.position)) {
            throw new Error("invalid_state");
          }
          armDeadline();
          setSnapshot({ scope, data, connected: true });
          if (typeof data.theme === "string") applyTheme(data.theme);
        } catch { disconnected(); ws.close(); }
      };
      ws.onclose = disconnected;
      ws.onerror = () => { disconnected(); ws.close(); };
    };
    connect();
    return () => {
      cancelled = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [apiBase, asUserId, isAuthed, scope]);
  const current = snapshot?.scope === scope && isAuthed ? snapshot : null;
  return { state: current?.data ?? null, connected: current?.connected ?? false };
}
