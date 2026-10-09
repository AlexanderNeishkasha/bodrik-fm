import { useEffect, useRef } from "react";
import { ui } from "../../lang/ru";
import useStudioCurrentLabel from "./useStudioCurrentLabel";
import useStudioGuards from "./useStudioGuards";
import useStudioLibrary from "./useStudioLibrary";
import useStudioUploads from "./useStudioUploads";
import useStudioYoutubeDownload from "./useStudioYoutubeDownload";
import useUploadDrop from "./useUploadDrop";
import { displayName } from "../lib/format";

const EMPTY_YOUTUBE_DOWNLOADS = Object.freeze([]);

/** Compose library CRUD, uploads, downloads, guards and drag/drop state. */
export default function useStudioLibraryState({
  apiBase,
  asUserId,
  isAuthed,
  showNotice,
  setStatus,
  setLibraryBusy,
  state,
  renameWhilePlayingMessage,
  deleteWhilePlayingMessage,
  noTrackLabel,
}) {
  const fileInputRef = useRef(null);
  const youtubeErrorNoticesRef = useRef(new Set());
  const youtubeStatusesRef = useRef(new Map());
  const youtubeStatusesInitializedRef = useRef(false);
  const {
    sections,
    setSections,
    tracks,
    setTracks,
    fetchTracks,
    applyLibraryPayload,
    isEditingLibrary,
    toggleEdit,
    editingTrackId,
    editingValue,
    setEditingValue,
    startRename,
    cancelRename,
    confirmRename,
    deleteTarget,
    requestDelete,
    clearDeleteTarget,
    confirmDelete,
    newSectionName,
    setNewSectionName,
    isAddingSection,
    startAddSection,
    cancelAddSection,
    createSection,
    editingSectionId,
    editingSectionName,
    setEditingSectionName,
    startRenameSection,
    cancelRenameSection,
    confirmRenameSection,
    deleteSection,
    collapsedSectionIds,
    toggleSectionCollapsed,
  } = useStudioLibrary({
    apiBase,
    asUserId,
    isAuthed,
    showNotice,
    setStatus,
    setIsBusy: setLibraryBusy,
  });
  const { uploads, upload, uploadFiles } = useStudioUploads({
    apiBase,
    asUserId,
    setIsBusy: setLibraryBusy,
    setStatus,
    showNotice,
    fetchTracks,
  });
  const youtube = useStudioYoutubeDownload({
    apiBase,
    asUserId,
    setIsBusy: setLibraryBusy,
    setStatus,
    showNotice,
  });
  const {
    isDragging,
    onDragOver: onFileDragOver,
    onDragLeave: onFileDragLeave,
    onDrop: onFileDrop,
  } = useUploadDrop({ uploadFiles });

  const { guardRenamePlaying, guardDeletePlaying } = useStudioGuards({
    state,
    tracks,
    editingTrackId,
    confirmRename,
    requestDelete,
    cancelRename,
    showNotice,
    renameWhilePlayingMessage,
    deleteWhilePlayingMessage,
  });

  const currentLabel = useStudioCurrentLabel({
    state,
    displayName,
    noTrackLabel,
    fetchTracks,
  });

  const youtubeDownloads = state?.youtube_downloads ?? EMPTY_YOUTUBE_DOWNLOADS;

  useEffect(() => {
    if (!state) {
      youtubeErrorNoticesRef.current.clear();
      youtubeStatusesRef.current.clear();
      youtubeStatusesInitializedRef.current = false;
      return;
    }

    const nextStatuses = new Map();
    const visibleIds = new Set();

    for (const download of youtubeDownloads) {
      if (!download?.id) {
        continue;
      }

      visibleIds.add(download.id);
      nextStatuses.set(download.id, download.status);

      if (download.status !== "error") {
        continue;
      }

      if (!youtubeStatusesInitializedRef.current) {
        youtubeErrorNoticesRef.current.add(download.id);
        continue;
      }

      const previousStatus = youtubeStatusesRef.current.get(download.id);
      if (
        previousStatus !== "error" &&
        !youtubeErrorNoticesRef.current.has(download.id)
      ) {
        showNotice(ui.messages.youtubeDownloadFailed);
        setStatus(ui.messages.youtubeDownloadFailed);
        youtubeErrorNoticesRef.current.add(download.id);
      }
    }

    for (const id of youtubeErrorNoticesRef.current) {
      if (!visibleIds.has(id)) {
        youtubeErrorNoticesRef.current.delete(id);
      }
    }

    youtubeStatusesRef.current = nextStatuses;
    youtubeStatusesInitializedRef.current = true;
  }, [setStatus, showNotice, state, youtubeDownloads]);

  /** Open the hidden file picker for an explicit upload action. */
  const triggerUpload = () => {
    fileInputRef.current?.click();
  };

  return {
    sections,
    setSections,
    tracks,
    setTracks,
    applyLibraryPayload,
    uploads,
    youtubeDownloads,
    youtube,
    isEditingLibrary,
    toggleEdit,
    editingTrackId,
    editingValue,
    setEditingValue,
    startRename,
    cancelRename,
    guardRenamePlaying,
    guardDeletePlaying,
    deleteTarget,
    clearDeleteTarget,
    confirmDelete,
    newSectionName,
    setNewSectionName,
    isAddingSection,
    startAddSection,
    cancelAddSection,
    createSection,
    editingSectionId,
    editingSectionName,
    setEditingSectionName,
    startRenameSection,
    cancelRenameSection,
    confirmRenameSection,
    deleteSection,
    collapsedSectionIds,
    toggleSectionCollapsed,
    isDragging,
    onFileDragOver,
    onFileDragLeave,
    onFileDrop,
    fileInputRef,
    upload,
    triggerUpload,
    triggerYoutube: youtube.toggleYoutube,
    currentLabel,
  };
}
