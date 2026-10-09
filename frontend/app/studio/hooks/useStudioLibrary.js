import { useEffect, useState } from "react";
import { ui } from "../../lang/ru";
import { displayName } from "../lib/format";
import { localizeApiMessage } from "../lib/localizeApiMessage";
import { deferEffect } from "../../lib/deferEffect";
import useStoredCollapsedSections from "./useStoredCollapsedSections";
import useStudioLibraryRequests from "./useStudioLibraryRequests";

/** Localize one library mutation result without exposing private response details. */
function resultMessage(result, fallback) {
  const message = result?.data?.message || "action failed";
  return { raw: message, localized: localizeApiMessage(message, fallback) };
}

/** Own Studio library drafts while transport handles cancellation and authority. */
export default function useStudioLibrary({
  apiBase,
  asUserId,
  isAuthed,
  showNotice,
  setStatus,
  setIsBusy,
}) {
  const [sections, setSections] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [isEditingLibrary, setIsEditingLibrary] = useState(false);
  const [editingTrackId, setEditingTrackId] = useState(null);
  const [editingValue, setEditingValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [newSectionName, setNewSectionName] = useState("");
  const [isAddingSection, setIsAddingSection] = useState(false);
  const [editingSectionId, setEditingSectionId] = useState(null);
  const [editingSectionName, setEditingSectionName] = useState("");
  const { collapsedSectionIds, toggleSectionCollapsed, removeCollapsedSection } =
    useStoredCollapsedSections({ asUserId, isAuthed });
  const { fetchTracks, applyLibraryPayload, mutateLibrary } = useStudioLibraryRequests({
    apiBase,
    asUserId,
    isAuthed,
    setIsBusy,
    setSections,
    setTracks,
  });

  useEffect(() => {
    if (!isAuthed) {
      return deferEffect(() => {
        setSections([]);
        setTracks([]);
        setIsEditingLibrary(false);
        setEditingTrackId(null);
        setEditingValue("");
        setDeleteTarget(null);
        setNewSectionName("");
        setIsAddingSection(false);
        setEditingSectionId(null);
        setEditingSectionName("");
      });
    }
    return deferEffect(() => {
      fetchTracks();
    });
  }, [fetchTracks, isAuthed]);

  /** Open one track rename draft from its display name. */
  const startRename = (track) => {
    setEditingTrackId(track.id);
    setEditingValue(displayName(track.filename));
  };

  /** Clear the active track rename draft. */
  const cancelRename = () => {
    setEditingTrackId(null);
    setEditingValue("");
  };

  /** Persist one nonempty changed track name. */
  const confirmRename = async (track) => {
    const next = editingValue.trim();
    if (!next || next === displayName(track.filename)) { cancelRename(); return; }
    const result = await mutateLibrary("/api/studio/track/rename", { id: track.id, to: next });
    if (result.aborted) return;
    if (result.ok) {
      setStatus("renamed");
    } else {
      const message = resultMessage(result, ui.messages.renameFailed);
      showNotice(message.raw === "playing" ? ui.messages.renameWhilePlaying : message.localized);
      setStatus(message.localized);
    }
    cancelRename();
  };

  /** Open track deletion confirmation for one target. */
  const requestDelete = (track) => {
    setDeleteTarget(track);
  };

  /** Close track deletion confirmation. */
  const clearDeleteTarget = () => {
    setDeleteTarget(null);
  };

  /** Delete the confirmed track unless the request becomes obsolete. */
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const result = await mutateLibrary("/api/studio/track/delete", { id: deleteTarget.id });
    if (result.aborted) return;
    if (result.ok) {
      setStatus("deleted");
    } else {
      const message = resultMessage(result, ui.messages.deleteFailed);
      showNotice(message.raw === "playing" ? ui.messages.deleteWhilePlaying : message.localized);
      setStatus(message.localized);
    }
    setDeleteTarget(null);
  };

  /** Toggle library editing controls. */
  const toggleEdit = () => setIsEditingLibrary((prev) => !prev);

  /** Run one section mutation through the owned cancellable transport. */
  const apiAction = async (path, body, fallback) => {
    const result = await mutateLibrary(path, body);
    if (result.ok) return true;
    if (result.aborted) return false;
    const message = resultMessage(result, fallback).localized;
    showNotice(message);
    setStatus(message);
    return false;
  };

  /** Toggle the new-section draft. */
  const startAddSection = () => {
    setIsAddingSection((value) => !value);
    setNewSectionName("");
  };

  /** Clear and close the new-section draft. */
  const cancelAddSection = () => {
    setIsAddingSection(false);
    setNewSectionName("");
  };

  /** Persist one nonempty section draft. */
  const createSection = async () => {
    const name = newSectionName.trim();
    if (!name) { cancelAddSection(); return; }
    const ok = await apiAction("/api/studio/sections", { name }, ui.messages.actionFailed);
    if (ok) {
      setStatus("section created");
      cancelAddSection();
    }
  };

  /** Open one section rename draft. */
  const startRenameSection = (section) => {
    setEditingSectionId(section.id);
    setEditingSectionName(section.name);
  };

  /** Clear the active section rename draft. */
  const cancelRenameSection = () => {
    setEditingSectionId(null);
    setEditingSectionName("");
  };

  /** Persist one changed section name. */
  const confirmRenameSection = async (section) => {
    const name = editingSectionName.trim();
    if (!name || name === section.name) { cancelRenameSection(); return; }
    const ok = await apiAction(
      "/api/studio/sections/rename",
      { id: section.id, name },
      ui.messages.actionFailed
    );
    if (ok) {
      setStatus("section renamed");
      cancelRenameSection();
    }
  };

  /** Delete one section and its local collapsed-state hint after success. */
  const deleteSection = async (section) => {
    const ok = await apiAction(
      "/api/studio/sections/delete",
      { id: section.id },
      ui.messages.actionFailed
    );
    if (ok) {
      setStatus("section deleted");
      removeCollapsedSection(section.id);
    }
  };

  return {
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
  };
}
