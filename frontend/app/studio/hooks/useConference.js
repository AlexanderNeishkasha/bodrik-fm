import { useCallback, useEffect, useRef, useState } from "react";
import { ui } from "../../lang/ru";
import { normalizeConferenceVolume } from "../lib/requestPolicy.mjs";
import { reconcileConferenceRoomSnapshot } from "../lib/conferenceSnapshot.mjs";

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
        if (error?.name !== "AbortError") {
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
      if (error?.name !== "AbortError") showNotice(failureMessage);
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
      ui.studio.meetingSettingsFailed,
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
      ui.studio.meetingOutputFailed,
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
        if (error?.name !== "AbortError" && musicVolumeRequestRef.current === controller) {
          setVolumeState({ scope, value: null });
          showNotice(ui.studio.meetingVolumeFailed);
        }
      } finally {
        if (musicVolumeRequestRef.current === controller) musicVolumeRequestRef.current = null;
      }
    };
    musicVolumeTimerRef.current = setTimeout(persist, 200);
  }, [apiBase, headers, scope, showNotice]);

  /** Copy the current public invitation without exposing provider identifiers. */
  const copyGuestLink = useCallback(async () => {
    if (!current.inviteUrl || typeof window === "undefined") return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(current.inviteUrl);
        showNotice(ui.studio.meetingLinkCopied);
      } else {
        window.prompt(ui.studio.meetingCopyPrompt, current.inviteUrl);
      }
    } catch {
      showNotice(ui.studio.meetingCopyFailed);
    }
  }, [current.inviteUrl, showNotice]);

  /** Request a fresh presenter URL and open only the returned backend authority. */
  const join = useCallback(async () => {
    const payload = await runAction(
      "/api/studio/conference/join",
      { json: true },
      ui.studio.meetingOpenFailed,
    );
    if (typeof payload?.join_url === "string") {
      window.open(payload.join_url, "_blank", "noopener,noreferrer");
    }
  }, [runAction]);

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
    join,
  };
}
