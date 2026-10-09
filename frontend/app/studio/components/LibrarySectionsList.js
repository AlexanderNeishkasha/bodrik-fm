import { useMemo } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import LibrarySection, { librarySectionSortId } from "./LibrarySection";
import LibraryFadeItem from "./LibraryFadeItem";
import { useLibraryPresence } from "../hooks/useLibraryPresence";

/** Keep current categories interactive and retain only inert previews during their departure. */
export default function LibrarySectionsList({
  active,
  sections,
  hideExitingTracks = false,
  tracks,
  setSectionsEndRef,
  isOverSectionsEnd,
  isEditingLibrary,
  collapsedSectionIds,
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
  onToggleSectionCollapsed,
  onPlay,
  onQueue,
  displayName,
}) {
  const currentEntries = useMemo(() => sections.map(section => ({
    key: `section:${section.id}`,
    section,
    tracks: tracksForSection(tracks, section.id),
    isCollapsed: collapsedSectionIds?.has(String(section.id)),
  })), [sections, tracks, collapsedSectionIds]);
  const { entries, reducedMotion, finishExit } = useLibraryPresence(currentEntries);
  if (entries.length === 0 && active?.data?.current?.type !== "library-section") return null;

  return (
    <SortableContext
      items={sections.map(section => librarySectionSortId(section.id))}
      strategy={verticalListSortingStrategy}
    >
      <div className="space-y-3">
        {entries.map(entry => (
          <LibraryFadeItem
            key={entry.key}
            entryKey={entry.key}
            isExiting={entry.isExiting}
            reducedMotion={reducedMotion}
            onExited={finishExit}
          >
            {entry.isExiting ? (
              <LibrarySectionPreview
                section={entry.section}
                tracks={entry.tracks}
                isCollapsed={hideExitingTracks || entry.isCollapsed}
                displayName={displayName}
              />
            ) : (
              <LibrarySection
                section={entry.section}
                tracks={entry.tracks}
                isEditingLibrary={isEditingLibrary}
                isCollapsed={entry.isCollapsed}
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
                onToggleCollapsed={onToggleSectionCollapsed}
                onPlay={onPlay}
                onQueue={onQueue}
                displayName={displayName}
              />
            )}
          </LibraryFadeItem>
        ))}
        {sections.length > 0 || active?.data?.current?.type === "library-section" ? (
          <div
            ref={setSectionsEndRef}
            className={`h-2 rounded-full transition ${
              active?.data?.current?.type === "library-section" && isOverSectionsEnd
                ? "bg-[var(--theme-accent-60)]" : ""
            }`}
          />
        ) : null}
      </div>
    </SortableContext>
  );
}

/** Render a display-only departure without registering draggable or droppable targets. */
function LibrarySectionPreview({ section, tracks, isCollapsed, displayName }) {
  return (
    <section
      className={`rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-input-bg)] p-3 ${
        isCollapsed ? "" : "space-y-2"
      }`}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <div className="btn-ghost inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)]">
          {section.name}
        </h3>
      </div>
      {isCollapsed ? null : (
        <div className="space-y-2">
          {tracks.map((track) => (
            <div
              key={track.id}
              className="ml-5 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] px-4 py-3 text-[var(--theme-text)]"
            >
              <span className="truncate">{displayName(track.filename)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Derive one category from canonical tracks in their persisted order. */
function tracksForSection(tracks, sectionId) {
  return tracks
    .filter((track) => String(track.section_id) === String(sectionId))
    .sort(trackSort);
}

/** Break persisted-order ties by the original filename. */
function trackSort(a, b) {
  return (
    (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
    String(a.filename ?? "").localeCompare(String(b.filename ?? ""))
  );
}
