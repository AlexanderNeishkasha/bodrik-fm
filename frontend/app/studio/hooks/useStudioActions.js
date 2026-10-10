import { useCallback } from "react";
import { readApiMessage } from "../../lib/apiMessage";
import { isAbortError } from "../../lib/abortError.mjs";

/** Own authenticated Studio commands and consistent public failure reporting. */
export default function useStudioActions({
  apiBase,
  asUserId,
  showNotice,
  setStatus,
  setThemeBusy,
  setSlugBusy,
  actionFailedMessage,
}) {
  /** Build optional JSON and impersonation headers for one command. */
  const buildHeaders = useCallback(({ json = false } = {}) => {
    const headers = {};
    if (json) headers["Content-Type"] = "application/json";
    if (asUserId != null) headers["x-studio-as-user-id"] = String(asUserId);
    return Object.keys(headers).length > 0 ? headers : undefined;
  }, [asUserId]);

  /** Send one playback/library command and return its optional response payload. */
  const sendAction = useCallback(async (path, body) => {
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: buildHeaders({ json: Boolean(body) }),
        credentials: "include",
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.ok) {
        setStatus("ready");
        try {
          return await response.json();
        } catch {
          return null;
        }
      }
      const message = await readApiMessage(response, actionFailedMessage);
      showNotice(message);
      setStatus(message);
    } catch {
      showNotice(actionFailedMessage);
      setStatus(actionFailedMessage);
    }
    return null;
  }, [actionFailedMessage, apiBase, buildHeaders, setStatus, showNotice]);

  /** Persist a theme while always releasing its busy state. */
  const setTheme = useCallback(async (theme) => {
    setThemeBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/studio/theme`, {
        method: "POST",
        headers: buildHeaders({ json: true }),
        credentials: "include",
        body: JSON.stringify({ theme }),
      });
      if (response.ok) {
        setStatus("ready");
        return true;
      }
      const message = await readApiMessage(response, actionFailedMessage);
      showNotice(message);
      setStatus(message);
    } catch {
      showNotice(actionFailedMessage);
      setStatus(actionFailedMessage);
    } finally {
      setThemeBusy(false);
    }
    return false;
  }, [actionFailedMessage, apiBase, buildHeaders, setStatus, setThemeBusy, showNotice]);

  /** Persist a room slug, allowing the draft owner to cancel obsolete requests. */
  const setRoomSlug = useCallback(async (slug, { signal } = {}) => {
    if (!setSlugBusy) return null;
    setSlugBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/studio/room/slug`, {
        method: "POST",
        headers: buildHeaders({ json: true }),
        credentials: "include",
        signal,
        body: JSON.stringify({ slug }),
      });
      if (!response.ok) {
        const message = await readApiMessage(response, actionFailedMessage);
        if (!signal?.aborted) {
          showNotice(message);
          setStatus(message);
        }
        return null;
      }
      const data = await response.json();
      if (signal?.aborted) return null;
      setStatus("ready");
      return data?.slug ?? null;
    } catch (error) {
      if (!isAbortError(error)) {
        showNotice(actionFailedMessage);
        setStatus(actionFailedMessage);
      }
      return null;
    } finally {
      setSlugBusy(false);
    }
  }, [actionFailedMessage, apiBase, buildHeaders, setSlugBusy, setStatus, showNotice]);

  /** Persist room listing while allowing the draft owner to cancel obsolete requests. */
  const setRoomListed = useCallback(async (listed, { signal } = {}) => {
    if (!setSlugBusy) return null;
    setSlugBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/studio/room/listed`, {
        method: "POST",
        headers: buildHeaders({ json: true }),
        credentials: "include",
        signal,
        body: JSON.stringify({ listed: Boolean(listed) }),
      });
      if (!response.ok) {
        const message = await readApiMessage(response, actionFailedMessage);
        if (!signal?.aborted) {
          showNotice(message);
          setStatus(message);
        }
        return null;
      }
      const data = await response.json();
      if (signal?.aborted) return null;
      setStatus("ready");
      return Boolean(data?.listed);
    } catch (error) {
      if (!isAbortError(error)) {
        showNotice(actionFailedMessage);
        setStatus(actionFailedMessage);
      }
      return null;
    } finally {
      setSlugBusy(false);
    }
  }, [actionFailedMessage, apiBase, buildHeaders, setSlugBusy, setStatus, showNotice]);

  return { sendAction, setTheme, setRoomSlug, setRoomListed };
}
