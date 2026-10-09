import { useState } from "react";
import { filterLibraryTracks } from "../lib/librarySearch.mjs";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { ui } from "../../lang/ru";
import LibraryHeader from "./LibraryHeader";
import LibraryDownloads from "./LibraryDownloads";
import LibraryUploads from "./LibraryUploads";
import YoutubeDownloadForm from "./YoutubeDownloadForm";
import SectionCreateForm from "./SectionCreateForm";
import CollapsibleLibraryBlock from "./CollapsibleLibraryBlock";
import LibrarySectionsList from "./LibrarySectionsList";
import LibraryLooseTracksList from "./LibraryLooseTracksList";
import listStyles from "./StudioListPanel.module.css";
import {
  isLibraryDropTarget,
  isLibrarySectionHeaderTarget,
  LIBRARY_LOOSE_TRACKS_TARGET,
  LIBRARY_SECTIONS_END_TARGET,
} from "../lib/libraryDndHandlers.mjs";

/** Render the canonical categorized library or a local, flat song-name search. */
export default function LibraryPanel({
  sections,
  tracks,
  uploads,
  youtubeDownloads,
  onDismissYoutubeDownload,
  youtubeModal,
  isEditingLibrary,
  isDragging,
  fileInputRef,
  onUpload,
  onTriggerUpload,
  onTriggerYoutube,
  onToggleEdit,
  newSectionName,
  onNewSectionNameChange,
  isAddingSection,
  onStartAddSection,
  onCancelAddSection,
  onCreateSection,
  onDragOver,
  onDragLeave,
  onDrop,
  isBusy,
  editingTrackId,
  editingValue,
  onEditValueChange,
  onStartRename,
  onCancelRename,
  onConfirmRename,
  onRequestDelete,
  editingSectionId,
  editingSectionName,
  onEditingSectionNameChange,
  onStartRenameSection,
  onCancelRenameSection,
  onConfirmRenameSection,
  onDeleteSection,
  collapsedSectionIds,
  onToggleSectionCollapsed,
  onPlay,
  onQueue,
  displayName,
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const isSearching = searchQuery.trim().length > 0;
  const filteredTracks = isSearching
    ? filterLibraryTracks(tracks, searchQuery, displayName).sort(trackSort)
    : [];
  const { active, over } = useDndContext();
  const { setNodeRef, isOver: isOverLibraryDrop } = useDroppable({
    id: "library-drop",
    disabled: isSearching,
  });
  const { setNodeRef: setSectionsEndRef, isOver: isOverSectionsEnd } =
    useDroppable({
      id: LIBRARY_SECTIONS_END_TARGET,
      disabled: isSearching || active?.data?.current?.type !== "library-section",
    });
  const isEmpty =
    (sections?.length ?? 0) === 0 &&
    tracks.length === 0 &&
    uploads.length === 0 &&
    (youtubeDownloads?.length ?? 0) === 0;
  const sortedSections = [...(sections ?? [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)
  );
  const looseTracks = tracks
    .filter((track) => track.section_id == null)
    .sort(trackSort);
  const { setNodeRef: setLooseDropRef } = useDroppable({
    id: LIBRARY_LOOSE_TRACKS_TARGET,
    disabled:
      isSearching || active?.data?.current?.type !== "library" || looseTracks.length > 0,
  });
  const isLibraryTrackDrag = active?.data?.current?.type === "library";
  const overData = over?.data?.current;
  const isOverHighlightedSection =
    isLibraryTrackDrag &&
    (isLibrarySectionHeaderTarget(over?.id) ||
      overData?.type === "library-section-drop" ||
      (overData?.type === "library" && overData.sectionId != null));
  const isLibraryDragOverPanel =
    isLibraryTrackDrag &&
    !isOverHighlightedSection &&
    (isOverLibraryDrop || isLibraryDropTarget(over?.id));

  return (
    <aside
      className={`${listStyles.panel} panel-shadow-card min-w-0 space-y-6 rounded-[28px] border border-[var(--theme-border)] bg-[var(--theme-card)] p-8 ${
        isDragging || isLibraryDragOverPanel
          ? "ring-2 ring-[var(--theme-accent-60)]"
          : ""
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      ref={setNodeRef}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp3,.flac,.m4a,.wav,.ogg,.opus,.aac,.mp4,.webm,audio/*,video/*"
        multiple
        onChange={onUpload}
        className="hidden"
        disabled={isBusy}
      />

      <div className="space-y-4">
        <LibraryHeader
          isEditingLibrary={isEditingLibrary}
          isAddingSection={isAddingSection}
          isYoutubeOpen={Boolean(youtubeModal?.isOpen)}
          isBusy={isBusy}
          onTriggerUpload={onTriggerUpload}
          onTriggerYoutube={onTriggerYoutube}
          onToggleEdit={onToggleEdit}
          onStartAddSection={onStartAddSection}
        />
        <input
          type="search"
          aria-label={ui.studio.searchLibrary}
          placeholder={ui.studio.searchLibrary}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="block w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-4 py-2 text-sm text-[var(--theme-text)] placeholder:text-[var(--theme-muted)]"
        />
        <CollapsibleLibraryBlock isOpen={isAddingSection}>
          <SectionCreateForm
            name={newSectionName}
            isBusy={isBusy}
            autoFocus={isAddingSection}
            onNameChange={onNewSectionNameChange}
            onCancel={onCancelAddSection}
            onCreate={onCreateSection}
          />
        </CollapsibleLibraryBlock>
        <YoutubeDownloadForm {...youtubeModal} isBusy={isBusy} />
        <div className="space-y-2 text-sm">
          <LibraryUploads uploads={uploads} displayName={displayName} />
          <LibraryDownloads
            downloads={youtubeDownloads}
            displayName={displayName}
            onDismiss={onDismissYoutubeDownload}
          />
          <div className="space-y-3">
            <LibrarySectionsList
              active={active}
              sections={isSearching ? [] : sortedSections}
              hideExitingTracks={isSearching}
              tracks={tracks}
              setSectionsEndRef={setSectionsEndRef}
              isOverSectionsEnd={isOverSectionsEnd}
              isEditingLibrary={isEditingLibrary}
              collapsedSectionIds={collapsedSectionIds}
              editingTrackId={editingTrackId}
              editingValue={editingValue}
              onEditValueChange={onEditValueChange}
              onStartRename={onStartRename}
              onCancelRename={onCancelRename}
              onConfirmRename={onConfirmRename}
              onRequestDelete={onRequestDelete}
              editingSectionId={editingSectionId}
              editingSectionName={editingSectionName}
              onEditingSectionNameChange={onEditingSectionNameChange}
              onStartRenameSection={onStartRenameSection}
              onCancelRenameSection={onCancelRenameSection}
              onConfirmRenameSection={onConfirmRenameSection}
              onDeleteSection={onDeleteSection}
              onToggleSectionCollapsed={onToggleSectionCollapsed}
              onPlay={onPlay}
              onQueue={onQueue}
              displayName={displayName}
            />
            <LibraryLooseTracksList
              active={active}
              tracks={isSearching ? filteredTracks : looseTracks}
              searchQuery={isSearching ? searchQuery : ""}
              emptyMessage={isSearching && filteredTracks.length === 0
                ? { key: "message:search-empty", text: ui.studio.noSearchResults, role: "status" }
                : !isSearching && isEmpty
                  ? { key: "message:library-empty", text: ui.studio.noUploads }
                  : undefined}
              setLooseDropRef={isSearching ? undefined : setLooseDropRef}
              isEditingLibrary={isEditingLibrary}
              editingTrackId={editingTrackId}
              editingValue={editingValue}
              onEditValueChange={onEditValueChange}
              onStartRename={onStartRename}
              onCancelRename={onCancelRename}
              onConfirmRename={onConfirmRename}
              onRequestDelete={onRequestDelete}
              onPlay={onPlay}
              onQueue={onQueue}
              displayName={displayName}
            />
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Keep visible songs in persisted order with a deterministic filename tie-break. */
function trackSort(a, b) {
  return (
    (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
    String(a.filename ?? "").localeCompare(String(b.filename ?? ""))
  );
}
