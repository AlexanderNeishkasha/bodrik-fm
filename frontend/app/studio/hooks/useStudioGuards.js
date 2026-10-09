import { useCallback, useEffect } from "react";

/** Guard active-track rename/delete commands and keyboard rename submission. */
export default function useStudioGuards({
  state,
  tracks,
  editingTrackId,
  confirmRename,
  requestDelete,
  cancelRename,
  showNotice,
  renameWhilePlayingMessage,
  deleteWhilePlayingMessage,
}) {
  const currentFilename = state?.current?.filename;
  /** Reject renaming the authoritative current track. */
  const guardRenamePlaying = useCallback(
    async (track) => {
      if (!track) {
        return;
      }
      const currentName = currentFilename;
      if (currentName && track.filename === currentName) {
        showNotice(renameWhilePlayingMessage);
        return;
      }
      await confirmRename(track);
    },
    [
      confirmRename,
      renameWhilePlayingMessage,
      showNotice,
      currentFilename,
    ]
  );

  /** Reject deleting the authoritative current track. */
  const guardDeletePlaying = useCallback(
    (track) => {
      if (!track) {
        return;
      }
      const currentName = currentFilename;
      if (currentName && track.filename === currentName) {
        showNotice(deleteWhilePlayingMessage);
        return;
      }
      requestDelete(track);
    },
    [
      deleteWhilePlayingMessage,
      requestDelete,
      showNotice,
      currentFilename,
    ]
  );

  useEffect(() => {
    if (!editingTrackId) {
      return undefined;
    }
    const handler = (event) => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
        return;
      }
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      const track = tracks.find((item) => item.id === editingTrackId);
      if (track) {
        guardRenamePlaying(track);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cancelRename, editingTrackId, guardRenamePlaying, tracks]);

  return { guardRenamePlaying, guardDeletePlaying };
}
