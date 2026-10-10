import { useCallback, useEffect, useRef } from "react";
import { isAbortError } from "../../lib/abortError.mjs";

/** Own cancellable Studio library reads and mutations. */
export default function useStudioLibraryRequests({
  apiBase,
  asUserId,
  isAuthed,
  setIsBusy,
  setSections,
  setTracks,
}) {
  const fetchControllerRef = useRef(null);
  const mutationControllerRef = useRef(null);
  const skipNextVersionFetchRef = useRef(false);

  useEffect(() => () => {
    fetchControllerRef.current?.abort();
    mutationControllerRef.current?.abort();
  }, []);

  /** Build JSON and impersonation headers for the current Studio identity. */
  const buildHeaders = useCallback(({ json = false } = {}) => {
    const headers = {};
    if (json) headers["Content-Type"] = "application/json";
    if (asUserId != null) headers["x-studio-as-user-id"] = String(asUserId);
    return Object.keys(headers).length > 0 ? headers : undefined;
  }, [asUserId]);

  /** Load one authoritative library snapshot and reject obsolete responses. */
  const fetchTracks = useCallback(async ({ reason } = {}) => {
    if (!isAuthed) {
      setSections([]);
      setTracks([]);
      return false;
    }
    if (reason === "library_version" && skipNextVersionFetchRef.current) {
      skipNextVersionFetchRef.current = false;
      return true;
    }
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    try {
      const response = await fetch(`${apiBase}/api/studio/library`, {
        headers: buildHeaders(),
        credentials: "include",
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        if (!controller.signal.aborted) {
          setSections([]);
          setTracks([]);
        }
        return false;
      }
      if (!response.ok) return false;
      const data = await response.json();
      if (controller.signal.aborted || fetchControllerRef.current !== controller) return false;
      setSections(Array.isArray(data?.sections) ? data.sections : []);
      setTracks(Array.isArray(data?.tracks) ? data.tracks : []);
      return true;
    } catch {
      return false;
    } finally {
      if (fetchControllerRef.current === controller) fetchControllerRef.current = null;
    }
  }, [apiBase, buildHeaders, isAuthed, setSections, setTracks]);

  /** Apply a command payload and suppress its matching version-triggered reload. */
  const applyLibraryPayload = useCallback((data) => {
    if (!data) return false;
    if (Array.isArray(data.sections)) setSections(data.sections);
    if (Array.isArray(data.tracks)) setTracks(data.tracks);
    skipNextVersionFetchRef.current = true;
    return true;
  }, [setSections, setTracks]);

  /** Run one exclusive mutation and return its parsed public result. */
  const mutateLibrary = useCallback(async (path, body, { refresh = true } = {}) => {
    mutationControllerRef.current?.abort();
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setIsBusy(true);
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: buildHeaders({ json: true }),
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {}
      if (controller.signal.aborted || mutationControllerRef.current !== controller) {
        return { ok: false, aborted: true, data: null };
      }
      if (!response.ok) {
        return { ok: false, aborted: false, data };
      }
      if (refresh) await fetchTracks();
      return { ok: true, aborted: false, data };
    } catch (error) {
      const aborted = isAbortError(error);
      return { ok: false, aborted, data: null };
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
        setIsBusy(false);
      }
    }
  }, [apiBase, buildHeaders, fetchTracks, setIsBusy]);

  return { fetchTracks, applyLibraryPayload, mutateLibrary };
}
