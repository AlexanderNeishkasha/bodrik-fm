import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../lang/index.js";
import { normalizeConferenceVolume } from "../lib/requestPolicy.mjs";
import { reconcileConferenceRoomSnapshot } from "../lib/conferenceSnapshot.mjs";
import { isAbortError } from "../../lib/abortError.mjs";
import { copyText } from "../lib/copyText.mjs";

/** Manage the optional conference capability without exposing its provider. */
export default function useConference({ apiBase, asUserId, isAuthed, roomState, showNotice }) {
  const scope = `${apiBase}:${asUserId ?? "self"}:${isAuthed}`;
  const [snapshot, setSnapshot] = useState({
    scope,
    allowed: false,
    enabled: false,
    inviteUrl: null,
  });
  const [roomObservation, setRoomObservation] = useState({ scope: null, allowed: null, enabled: null });
  const [busyState, setBusyState] = useState({ scope, value: false });
  const [volumeState, setVolumeState] = useState({ scope, value: null });
  const actionControllerRef = useRef(null);
  const musicVolumeRequestRef = useRef(null);
  const musicVolumeTimerRef = useRef(null);
  const current = snapshot.scope === scope
    ? snapshot
    : { scope, allowed: false, enabled: false, inviteUrl: null };
  const busy = busyState.scope === scope && busyState.value;
  const musicVolume = volumeState.scope === scope ? volumeState.value : null;

  /** Build conference headers for the currently authorized Studio identity. */
  const headers = useCallback((json = false) => {
    const value = {};
    if (json) value["Content-Type"] = "application/json";
    if (asUserId != null) value["x-studio-as-user-id"] = String(asUserId);
    return value;
  }, [asUserId]);

  useEffect(() => {
    const controller = new AbortController();
    if (!isAuthed) return () => controller.abort();
    fetch(`${apiBase}/api/studio/conference`, {
      credentials: "include",
      headers: headers(),
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (controller.signal.aborted) return;
        setSnapshot({
          scope,
          allowed: payload?.allowed === true,
          enabled: payload?.enabled === true,
          inviteUrl: typeof payload?.invite_url === "string" ? payload.invite_url : null,
        });
      })
      .catch((error) => {
        if (!isAbortError(error)) {
          setSnapshot({ scope, allowed: false, enabled: false, inviteUrl: null });
        }
      });
    return () => controller.abort();
  }, [apiBase, headers, isAuthed, scope]);

  const observedAllowed = roomState?.conference_allowed;
  const observedEnabled = roomState?.conference_enabled;
  // Track new stream observations, not a second UI state: unchanged fields must not overwrite command responses.
  if (roomObservation.scope !== scope || !Object.is(roomObservation.allowed, observedAllowed) || !Object.is(roomObservation.enabled, observedEnabled)) {
    setRoomObservation({ scope, allowed: observedAllowed, enabled: observedEnabled });
    if (typeof observedAllowed === "boolean" || typeof observedEnabled === "boolean") {
      setSnapshot(previous => reconcileConferenceRoomSnapshot(previous, scope, roomState));
    }
  }

  useEffect(() => () => {
    actionControllerRef.current?.abort();
    clearTimeout(musicVolumeTimerRef.current);
    musicVolumeTimerRef.current = null;
    musicVolumeRequestRef.current?.abort();
    musicVolumeRequestRef.current = null;
  }, [scope]);

  /** Run one exclusive conference mutation for the current scope. */
  const runAction = useCallback(async (path, options, failureMessage) => {
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setBusyState({ scope, value: true });
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        credentials: "include",
        headers: headers(options?.body != null),
        signal: controller.signal,
        body: options?.body == null ? undefined : JSON.stringify(options.body),
      });
      if (!response.ok) throw new Error("conference command failed");
      const payload = options?.json === false ? null : await response.json();
      return controller.signal.aborted ? null : payload;
    } catch (error) {
      if (!isAbortError(error)) showNotice(failureMessage);
      return null;
    } finally {
      if (actionControllerRef.current === controller) {
        actionControllerRef.current = null;
        setBusyState({ scope, value: false });
      }
    }
  }, [apiBase, headers, scope, showNotice]);

  /** Enable or disable the current room conference from the returned authority. */
  const setConferenceEnabled = useCallback(async (nextEnabled) => {
    const payload = await runAction(
      "/api/studio/conference",
      { body: { enabled: nextEnabled } },
      t("studio.meetingSettingsFailed"),
    );
    if (!payload) return;
    setSnapshot({
      scope,
      allowed: payload.allowed === true,
      enabled: payload.enabled === true,
      inviteUrl: typeof payload.invite_url === "string" ? payload.invite_url : null,
    });
  }, [runAction, scope]);

  /** Select local Studio or conference music output. */
  const setMusicOutput = useCallback(async (output) => {
    await runAction(
      "/api/studio/conference/music-output",
      { body: { output }, json: false },
      t("studio.meetingOutputFailed"),
    );
  }, [runAction]);

  /** Update the slider immediately and persist after 200 ms without input. */
  const setMusicVolume = useCallback((volume) => {
    const nextVolume = normalizeConferenceVolume(volume);
    if (nextVolume == null) return;
    setVolumeState({ scope, value: nextVolume });
    clearTimeout(musicVolumeTimerRef.current);
    musicVolumeRequestRef.current?.abort();
    musicVolumeRequestRef.current = null;
    /** Persist only the latest scheduled value; obsolete failures cannot roll back newer input. */
    const persist = async () => {
      musicVolumeTimerRef.current = null;
      const controller = new AbortController();
      musicVolumeRequestRef.current = controller;
      try {
        const response = await fetch(`${apiBase}/api/studio/conference/music-volume`, {
          method: "POST",
          credentials: "include",
          headers: headers(true),
          body: JSON.stringify({ volume: nextVolume }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("music volume update failed");
      } catch (error) {
        if (!isAbortError(error) && musicVolumeRequestRef.current === controller) {
          setVolumeState({ scope, value: null });
          showNotice(t("studio.meetingVolumeFailed"));
        }
      } finally {
        if (musicVolumeRequestRef.current === controller) musicVolumeRequestRef.current = null;
      }
    };
    musicVolumeTimerRef.current = setTimeout(persist, 200);
  }, [apiBase, headers, scope, showNotice]);

  /** Copy the current public invitation without exposing provider identifiers. */
  const copyGuestLink = useCallback(async () => {
    if (!current.inviteUrl || typeof window === "undefined") return false;
    if (!await copyText(current.inviteUrl)) {
      window.prompt(t("studio.meetingCopyPrompt"), current.inviteUrl);
      return false;
    }
    showNotice(t("studio.meetingLinkCopied"));
    return true;
  }, [current.inviteUrl, showNotice]);

  return {
    allowed: current.allowed,
    enabled: current.enabled,
    busy,
    inviteUrl: current.inviteUrl,
    musicVolume,
    setEnabled: setConferenceEnabled,
    setMusicOutput,
    setMusicVolume,
    copyGuestLink,
  };
}
