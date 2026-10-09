import { useEffect, useReducer, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ui } from "../../lang/ru";
import useStudioActions from "./useStudioActions";
import useAccountManagement from "./useAccountManagement";
import useStudioAuthState from "./useStudioAuthState";
import useStudioHotkeysBinding from "./useStudioHotkeysBinding";
import useStudioHotkeysState from "./useStudioHotkeysState";
import useStudioLibraryState from "./useStudioLibraryState";
import useConference from "./useConference";
import useStudioNotice from "./useStudioNotice";
import useStudioPlaybackState from "./useStudioPlaybackState";
import useStudioQueueState from "./useStudioQueueState";
import useStudioRoomDraft from "./useStudioRoomDraft";
import useStudioSeek from "./useStudioSeek";
import { deferEffect } from "../../lib/deferEffect";
import buildWorkspaceProps from "../lib/buildWorkspaceProps";
import buildHotkeysArgs from "../lib/buildHotkeysArgs";
import { API_BASE, MEDIA_BASE } from "../lib/constants";
import { displayName } from "../lib/format";
import { logoutAndResetStudioAsUser, parseStudioAsUserId, parseStudioAsUserIdValue } from "../lib/studioAsUser.mjs";

/** Assemble Studio state and route playback UI/hotkeys through the selected output. */
export default function useStudioPageState() {
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const [slugBusy, setSlugBusy] = useState(false);
  const [status, setStatus] = useState("idle");
  const [studioAsUserId, setStudioAsUserId] = useState(() => parseStudioAsUserId());
  const router = useRouter();
  const searchParams = useSearchParams();
  const { notice, showNotice } = useStudioNotice();
  const account = useAccountManagement({
    apiBase: API_BASE,
    showNotice,
    setStatus,
  });
  const {
    authBusy,
    loginName,
    setLoginName,
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    isRegisterMode,
    setIsRegisterMode,
    isAuthed,
    isAuthChecked,
    user,
    setUser,
    login,
    register,
    logout,
  } = useStudioAuthState({
    apiBase: API_BASE,
    asUserId: studioAsUserId,
    showNotice,
    setStatus,
  });
  const isSessionAdmin = user?.actor_role === "admin" || (user?.actor_role == null && user?.role === "admin");
  const activeAsUserId = isSessionAdmin ? studioAsUserId : null;
  const {
    state,
    audioRef,
    seekValue,
    setSeekValue,
    isSeekingRef,
    localVolume,
    localMuted,
    outputForcedMuted,
    toggleLocalMute,
    onLocalVolumeChange,
    changeLocalVolume,
    unlockAudio,
  } = useStudioPlaybackState({
    apiBase: API_BASE,
    asUserId: activeAsUserId,
    mediaBase: MEDIA_BASE,
    isAuthed,
    roomKey: user ? `${user.login}:${user.room_slug}` : "",
  });
  const conference = useConference({
    apiBase: API_BASE,
    asUserId: activeAsUserId,
    isAuthed,
    roomState: state,
    showNotice,
  });
  const libraryState = useStudioLibraryState({
    apiBase: API_BASE,
    asUserId: activeAsUserId,
    isAuthed,
    showNotice,
    setStatus,
    setLibraryBusy,
    state,
    renameWhilePlayingMessage: ui.messages.renameWhilePlaying,
    deleteWhilePlayingMessage: ui.messages.deleteWhilePlaying,
    noTrackLabel: ui.studio.noTrack,
  });
  const { sendAction, setTheme, setRoomSlug, setRoomListed } = useStudioActions({
    apiBase: API_BASE,
    asUserId: activeAsUserId,
    showNotice,
    setStatus,
    setThemeBusy,
    setSlugBusy,
    actionFailedMessage: ui.messages.actionFailed,
  });
  const { roomSlugInput, roomListedInput, setRoomSlugInput, setRoomListedInput } = useStudioRoomDraft({
    user,
    isAuthed,
    setRoomSlug,
    setRoomListed,
    setUser,
  });

  useEffect(() => {
    const nextAsUserId = parseStudioAsUserIdValue(searchParams.get("as"));
    return deferEffect(() => {
      setStudioAsUserId((current) => (current === nextAsUserId ? current : nextAsUserId));
    });
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!isAuthed || studioAsUserId == null || isSessionAdmin) {
      return;
    }
    const url = new URL(window.location.href);
    if (!url.searchParams.has("as")) {
      return deferEffect(() => setStudioAsUserId(null));
    }
    url.searchParams.delete("as");
    const nextPath = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextPath);
    return deferEffect(() => setStudioAsUserId(null));
  }, [isAuthed, isSessionAdmin, studioAsUserId]);

  const logoutAndReset = () =>
    logoutAndResetStudioAsUser({
      setStudioAsUserId,
      logout,
      navigateHome: () => router.replace("/"),
    });

  const { scheduleSeek, onSeek } = useStudioSeek({ isSeekingRef, setSeekValue, sendAction });
  const { showHotkeys, setShowHotkeys, isHydrated } = useStudioHotkeysState();
  const [interactionToken, bumpInteraction] = useReducer((value) => value + 1, 0);
  useStudioHotkeysBinding(
    buildHotkeysArgs({
      isAuthed,
      setShowHotkeys,
      toggleEdit: libraryState.toggleEdit,
      state,
      sendAction,
      toggleLocalMute,
      changeLocalVolume,
      unlockAudio,
      localMuted,
      localVolume,
      seekValue,
      setSeekValue,
      isSeekingRef,
      scheduleSeek,
      onEaster: bumpInteraction,
    }),
  );
  const { sensors, activeDrag, queueEntries, renderQueueIds, handleDragStart, handleDragOver, handleDragEnd, handleDragCancel } =
    useStudioQueueState({
      queueFromState: state?.queue,
      sections: libraryState.sections,
      setSections: libraryState.setSections,
      tracks: libraryState.tracks,
      setTracks: libraryState.setTracks,
      applyLibraryPayload: libraryState.applyLibraryPayload,
      isEditingLibrary: libraryState.isEditingLibrary,
      sendAction,
    });
  return buildWorkspaceProps({
    sensors,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
    activeDrag,
    displayName,
    isAuthed,
    isAuthChecked,
    authBusy,
    loginName,
    setLoginName,
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    isRegisterMode,
    setIsRegisterMode,
    login,
    register,
    logout: logoutAndReset,
    userLogin: user?.login ?? "",
    account,
    canManageAccount: activeAsUserId == null,
    showAdminBack: isSessionAdmin,
    conference,
    roomSlug: user?.room_slug ?? "",
    roomSlugInput,
    roomListedInput,
    setRoomSlugInput,
    setRoomListedInput,
    slugBusy,
    audioRef,
    currentLabel: libraryState.currentLabel,
    state,
    isSeekingRef,
    seekValue,
    setSeekValue,
    onSeek,
    localVolume,
    localMuted,
    outputForcedMuted,
    toggleLocalMute,
    onLocalVolumeChange,
    unlockAudio,
    queueEntries,
    renderQueueIds,
    sendAction,
    libraryState,
    libraryBusy,
    theme: state?.theme,
    setTheme,
    themeBusy,
    showHotkeys,
    setShowHotkeys,
    isHydrated,
    interactionToken,
    bumpInteraction,
    deleteTarget: libraryState.deleteTarget,
    clearDeleteTarget: libraryState.clearDeleteTarget,
    confirmDelete: libraryState.confirmDelete,
    notice,
    showNotice,
  });
}
