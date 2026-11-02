import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../lang/index.js";
import { localizeApiMessage } from "../lib/localizeApiMessage";
import { validateYoutubeUrl } from "../lib/youtube";
import { isAbortError } from "../../lib/abortError.mjs";

/** Own YouTube submission/dismiss requests and cancel obsolete Studio identity work. */
export default function useStudioYoutubeDownload({
  apiBase,
  asUserId,
  setIsBusy,
  setStatus,
  showNotice,
}) {
  const [isYoutubeOpen, setIsYoutubeOpen] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [youtubeError, setYoutubeError] = useState("");
  const submitControllerRef = useRef(null);
  const dismissControllersRef = useRef(new Map());

  useEffect(() => () => {
    const hadSubmission = Boolean(submitControllerRef.current);
    submitControllerRef.current?.abort();
    submitControllerRef.current = null;
    if (hadSubmission) setIsBusy(false);
    for (const controller of dismissControllersRef.current.values()) controller.abort();
    dismissControllersRef.current.clear();
  }, [apiBase, asUserId, setIsBusy]);

  /** Build JSON and optional impersonation headers. */
  const buildHeaders = useCallback(() => {
    const headers = { "Content-Type": "application/json" };
    if (asUserId != null) headers["x-studio-as-user-id"] = String(asUserId);
    return headers;
  }, [asUserId]);

  /** Toggle the URL form and clear stale validation feedback. */
  const toggleYoutube = useCallback(() => {
    setYoutubeError("");
    setIsYoutubeOpen((current) => !current);
  }, []);

  /** Close the URL form and clear stale validation feedback. */
  const closeYoutube = useCallback(() => {
    setIsYoutubeOpen(false);
    setYoutubeError("");
  }, []);

  /** Dismiss one terminal job with at most one in-flight request per ID. */
  const dismissYoutubeDownload = useCallback(async (id) => {
    if (!id || dismissControllersRef.current.has(id)) return;
    const controller = new AbortController();
    dismissControllersRef.current.set(id, controller);
    try {
      const response = await fetch(`${apiBase}/api/studio/youtube-downloads/dismiss`, {
        method: "POST",
        headers: buildHeaders(),
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({ id }),
      });
      if (!response.ok) throw new Error("dismiss failed");
    } catch (error) {
      if (!isAbortError(error)) {
        showNotice(t("messages.actionFailed"));
        setStatus(t("messages.actionFailed"));
      }
    } finally {
      if (dismissControllersRef.current.get(id) === controller) {
        dismissControllersRef.current.delete(id);
      }
    }
  }, [apiBase, buildHeaders, setStatus, showNotice]);

  /** Submit one validated URL and reject duplicate in-flight submissions. */
  const submitYoutube = useCallback(async () => {
    const nextUrl = youtubeUrl.trim();
    if (!validateYoutubeUrl(nextUrl)) {
      setYoutubeError(t("messages.invalidYoutubeUrl"));
      return;
    }
    if (submitControllerRef.current) return;
    const controller = new AbortController();
    submitControllerRef.current = controller;
    setIsBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/studio/youtube-downloads`, {
        method: "POST",
        headers: buildHeaders(),
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({ url: nextUrl }),
      });
      if (response.ok) {
        setYoutubeUrl("");
        closeYoutube();
        setStatus("youtube queued");
        return;
      }
      let rawMessage = "youtube download failed";
      try {
        const data = await response.json();
        if (data?.message) rawMessage = data.message;
      } catch {}
      if (controller.signal.aborted) return;
      const localized = localizeApiMessage(rawMessage, t("messages.youtubeDownloadFailed"));
      const publicMessage = localized === rawMessage ? t("messages.youtubeDownloadFailed") : localized;
      setYoutubeError(publicMessage);
      showNotice(publicMessage);
      setStatus(publicMessage);
    } catch (error) {
      if (!isAbortError(error)) {
        setYoutubeError(t("messages.youtubeDownloadFailed"));
        showNotice(t("messages.youtubeDownloadFailed"));
        setStatus(t("messages.youtubeDownloadFailed"));
      }
    } finally {
      if (submitControllerRef.current === controller) {
        submitControllerRef.current = null;
        setIsBusy(false);
      }
    }
  }, [apiBase, buildHeaders, closeYoutube, setIsBusy, setStatus, showNotice, youtubeUrl]);

  return {
    isYoutubeOpen,
    youtubeUrl,
    youtubeError,
    setYoutubeUrl,
    toggleYoutube,
    closeYoutube,
    submitYoutube,
    dismissYoutubeDownload,
  };
}
