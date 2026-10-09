import { useEffect, useRef, useState } from "react";
import { applyTheme } from "./theme";
import { deferEffect } from "./deferEffect";
import { normalizePublicStatePayload } from "./publicState.mjs";

const WS_RETRY_MS = 1500;
const WS_STALE_MS = 15000;

/** Follow one room's authoritative public snapshot over HTTP and WebSocket. */
export default function usePublicState({ apiBase, roomSlug, enabled = true, onRoomSlugChanged }) {
  const [status, setStatus] = useState("idle");
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [syncToken, setSyncToken] = useState(0);
  const stateWsRef = useRef(null);
  const stateWsRetryRef = useRef(null);
  const lastWsMessageAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || !roomSlug) {
      return deferEffect(() => {
        setStatus("idle");
        setCurrentTrack(null);
        setIsPlaying(false);
        setPosition(0);
        setSyncToken(0);
      });
    }

    let cancelled = false;
    let fetchController = null;
    const encodedSlug = encodeURIComponent(roomSlug);

    /** Apply one normalized authoritative snapshot to local render state. */
    const applyPayload = (data) => {
      const snapshot = normalizePublicStatePayload(data);
      setStatus("connected");
      if (snapshot.roomSlug && snapshot.roomSlug !== roomSlug && typeof onRoomSlugChanged === "function") {
        onRoomSlugChanged(snapshot.roomSlug);
      }
      setCurrentTrack(snapshot.currentTrack);
      setIsPlaying(snapshot.isPlaying);
      setPosition(snapshot.position);
      setSyncToken(snapshot.syncToken);
      if (snapshot.theme) applyTheme(snapshot.theme);
    };

    /** Cancel the pending socket reconnect timer. */
    const clearRetry = () => {
      if (stateWsRetryRef.current) {
        clearTimeout(stateWsRetryRef.current);
        stateWsRetryRef.current = null;
      }
    };

    /** Detach callbacks before closing the socket owned by this effect. */
    const closeSocket = () => {
      const ws = stateWsRef.current;
      if (!ws) {
        return;
      }
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      stateWsRef.current = null;
      try {
        ws.close();
      } catch {}
    };

    /** Replace any obsolete snapshot request with one current HTTP read. */
    const fetchState = async ({ quiet = false } = {}) => {
      if (!quiet) setStatus("connecting");
      fetchController?.abort();
      const controller = new AbortController();
      fetchController = controller;
      try {
        const res = await fetch(`${apiBase}/api/rooms/${encodedSlug}/state/public`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (cancelled || controller.signal.aborted) return false;
        if (res.status === 404) {
          setStatus("not_found");
          return false;
        }
        if (!res.ok) {
          if (!quiet) setStatus("error");
          return false;
        }
        const payload = await res.json();
        if (cancelled || controller.signal.aborted) return false;
        applyPayload(payload);
        return true;
      } catch (error) {
        if (!cancelled && error?.name !== "AbortError" && !quiet) setStatus("error");
        return false;
      } finally {
        if (fetchController === controller) fetchController = null;
      }
    };

    /** Open the room socket or expose an invalid URL/browser configuration. */
    const connect = () => {
      if (cancelled) {
        return;
      }
      clearRetry();
      closeSocket();

      let ws;
      try {
        const base = apiBase || window.location.origin;
        const url = new URL(base);
        const protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${url.host}/ws/rooms/${encodedSlug}/state/public`;
        ws = new WebSocket(wsUrl);
      } catch {
        setStatus("error");
        return;
      }
      stateWsRef.current = ws;
      lastWsMessageAtRef.current = Date.now();

      ws.onmessage = (event) => {
        if (cancelled || stateWsRef.current !== ws) return;
        lastWsMessageAtRef.current = Date.now();
        try {
          applyPayload(JSON.parse(event.data));
        } catch {
          return;
        }
      };
      ws.onclose = () => {
        if (stateWsRef.current === ws) {
          stateWsRef.current = null;
        }
        if (cancelled) {
          return;
        }
        setStatus("connecting");
        stateWsRetryRef.current = setTimeout(connect, WS_RETRY_MS);
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    /** Refresh authority and reconnect a missing or stale socket when requested. */
    const refresh = async ({ reconnectIfStale = false } = {}) => {
      const ok = await fetchState({ quiet: true });
      if (!ok || cancelled) {
        return;
      }
      const ws = stateWsRef.current;
      const isStale = Date.now() - lastWsMessageAtRef.current > WS_STALE_MS;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING || (reconnectIfStale && isStale)) {
        connect();
      }
    };

    /** Refresh when the browser becomes usable after suspension or network loss. */
    const handleResume = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      refresh({ reconnectIfStale: true });
    };

    /** Fetch the initial snapshot before opening the observation socket. */
    const bootstrap = async () => {
      const ok = await fetchState();
      if (!cancelled && ok) {
        connect();
      }
    };

    bootstrap();

    window.addEventListener("focus", handleResume);
    window.addEventListener("online", handleResume);
    window.addEventListener("pageshow", handleResume);
    document.addEventListener("visibilitychange", handleResume);
    const watchdog = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }
      const ws = stateWsRef.current;
      const isStale = Date.now() - lastWsMessageAtRef.current > WS_STALE_MS;
      if (!ws || ws.readyState !== WebSocket.OPEN || isStale) {
        refresh({ reconnectIfStale: true });
      }
    }, WS_STALE_MS);

    return () => {
      cancelled = true;
      fetchController?.abort();
      fetchController = null;
      clearRetry();
      closeSocket();
      window.removeEventListener("focus", handleResume);
      window.removeEventListener("online", handleResume);
      window.removeEventListener("pageshow", handleResume);
      document.removeEventListener("visibilitychange", handleResume);
      window.clearInterval(watchdog);
    };
  }, [apiBase, enabled, roomSlug, onRoomSlugChanged]);

  return {
    status,
    currentTrack,
    isPlaying,
    position,
    syncToken,
  };
}
