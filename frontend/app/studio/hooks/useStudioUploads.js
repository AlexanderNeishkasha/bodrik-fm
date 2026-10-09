import { useCallback, useEffect, useRef, useState } from "react";
import { ui } from "../../lang/ru";
import { localizeApiMessage } from "../lib/localizeApiMessage";
import { uploadId, uploadKey } from "../lib/uploadPolicy.mjs";

/** Own upload XHRs, progress rows, duplicate admission and delayed cleanup. */
export default function useStudioUploads({
  apiBase,
  asUserId,
  setIsBusy,
  setStatus,
  showNotice,
  fetchTracks,
}) {
  const [uploads, setUploads] = useState([]);
  const xhrsRef = useRef(new Map());
  const cleanupTimersRef = useRef(new Map());
  const inFlightKeysRef = useRef(new Set());
  const batchCountRef = useRef(0);
  const scopeGenerationRef = useRef(0);

  useEffect(() => () => {
    scopeGenerationRef.current += 1;
    for (const xhr of xhrsRef.current.values()) xhr.abort();
    xhrsRef.current.clear();
    inFlightKeysRef.current.clear();
    for (const timer of cleanupTimersRef.current.values()) clearTimeout(timer);
    cleanupTimersRef.current.clear();
  }, [apiBase, asUserId]);

  /** Remove one upload row after a visible failure delay. */
  const scheduleRemoval = useCallback((id) => {
    const previous = cleanupTimersRef.current.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      cleanupTimersRef.current.delete(id);
      setUploads((current) => current.filter((item) => item.id !== id));
    }, 2000);
    cleanupTimersRef.current.set(id, timer);
  }, []);

  /** Upload one admitted file and settle exactly once for load/error/abort. */
  const uploadFile = useCallback((file) => {
    if (!file) return Promise.resolve(false);
    const key = uploadKey(file);
    if (inFlightKeysRef.current.has(key)) {
      showNotice(ui.messages.fileExists);
      return Promise.resolve(false);
    }
    inFlightKeysRef.current.add(key);
    const nonce = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const id = uploadId(file, nonce);
    setUploads((current) => [
      ...current,
      { id, name: file.name, progress: 0, status: "uploading" },
    ]);

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      /** Release owned resources and resolve this upload once. */
      const settle = (result) => {
        if (settled) return;
        settled = true;
        xhrsRef.current.delete(id);
        inFlightKeysRef.current.delete(key);
        resolve(result);
      };
      /** Mark a visible failure and schedule row cleanup. */
      const fail = (message) => {
        if (settled) return;
        setUploads((current) => current.map((item) => (
          item.id === id ? { ...item, status: "error" } : item
        )));
        scheduleRemoval(id);
        showNotice(message);
        setStatus(message);
        settle(false);
      };

      xhrsRef.current.set(id, xhr);
      xhr.open("POST", `${apiBase}/api/studio/upload`, true);
      xhr.withCredentials = true;
      if (asUserId != null) xhr.setRequestHeader("x-studio-as-user-id", String(asUserId));
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || settled) return;
        const progress = Math.min(1, event.loaded / event.total);
        setUploads((current) => current.map((item) => (
          item.id === id ? { ...item, progress } : item
        )));
      };
      xhr.onload = () => {
        if (settled) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          setStatus("uploaded");
          setUploads((current) => current.filter((item) => item.id !== id));
          void fetchTracks();
          settle(true);
          return;
        }
        let rawMessage = "upload failed";
        try {
          const data = JSON.parse(xhr.responseText);
          if (data?.message) rawMessage = data.message;
        } catch {}
        if (rawMessage === "name exists") {
          setUploads((current) => current.filter((item) => item.id !== id));
          showNotice(ui.messages.fileExists);
          setStatus(ui.messages.fileExists);
          settle(false);
          return;
        }
        fail(localizeApiMessage(rawMessage, ui.messages.uploadFailed));
      };
      xhr.onerror = () => fail(ui.messages.uploadFailed);
      xhr.onabort = () => {
        if (settled) return;
        setUploads((current) => current.filter((item) => item.id !== id));
        settle(false);
      };
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  }, [apiBase, asUserId, fetchTracks, scheduleRemoval, setStatus, showNotice]);

  /** Upload a selected batch sequentially while preserving overlapping busy owners. */
  const uploadFiles = useCallback(async (files) => {
    if (!files.length) return;
    const generation = scopeGenerationRef.current;
    batchCountRef.current += 1;
    setIsBusy(true);
    try {
      for (const file of files) {
        if (scopeGenerationRef.current !== generation) break;
        await uploadFile(file);
      }
    } finally {
      batchCountRef.current -= 1;
      if (batchCountRef.current === 0) setIsBusy(false);
    }
  }, [setIsBusy, uploadFile]);

  /** Consume a file input selection and allow selecting the same file again later. */
  const upload = useCallback(async (event) => {
    const files = Array.from(event.target.files ?? []);
    await uploadFiles(files);
    event.target.value = "";
  }, [uploadFiles]);

  return { uploads, upload, uploadFiles };
}
