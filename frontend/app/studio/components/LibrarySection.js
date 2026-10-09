import { useState } from "react";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ui } from "../../lang/ru";
import Icon from "../../components/Icon";
import LibraryItem from "./LibraryItem";

const sectionDropId = (id) => `library-section-${id == null ? "none" : id}`;
const sectionSortId = (id) => `library-section-sort-${id}`;

export const libraryTrackSortId = (id) => `library-track-${id}`;
export const librarySectionSortId = (id) => sectionSortId(id);
export const librarySectionDropId = (id) => sectionDropId(id);

export default function LibrarySection({
  section,
  tracks,
  isEditingLibrary,
  isCollapsed,
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
  onToggleCollapsed,
  onPlay,
  onQueue,
  displayName,
  isExiting = false,
}) {
  const [shouldRenderTracks, setShouldRenderTracks] = useState(!isCollapsed);
  const { active, over } = useDndContext();
  const activeData = active?.data?.current;
  const isEditingThisSection = editingSectionId === section.id;
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: sectionSortId(section.id),
    data: {
      type: "library-section",
      id: section.id,
      filename: section.name,
    },
    disabled: isEditingThisSection || isExiting,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: sectionDropId(section.id),
    data: {
      type: "library-section-drop",
      sectionId: section.id,
    },
    disabled: activeData?.type === "library-section" || isExiting,
  });
  const setRefs = (node) => {
    setSortableRef(node);
    setDropRef(node);
  };
  const style = isDragging
    ? undefined
    : {
        transform: CSS.Transform.toString(transform),
        transition,
      };
  const overData = over?.data?.current;
  const isTrackOverSection =
    activeData?.type === "library" &&
    (over?.id === sectionDropId(section.id) ||
      over?.id === sectionSortId(section.id) ||
      (overData?.type === "library" && String(overData.sectionId) === String(section.id)));
  const showEmptyDropSlot = !isCollapsed && tracks.length === 0 && isTrackOverSection;
  const renderTracks = shouldRenderTracks || !isCollapsed;
  const toggleCollapsed = (event) => {
    event.stopPropagation();
    setShouldRenderTracks(true);
    onToggleCollapsed(section.id);
  };

  return (
    <section
      ref={setRefs}
      style={style}
      className={`rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-input-bg)] p-3 touch-none transition ${
        (activeData?.type === "library" && isOver) || isTrackOverSection ? "outline outline-2 outline-[var(--theme-accent-60)]" : ""
      } ${isDragging ? "opacity-30 cursor-grabbing" : ""} ${isCollapsed ? "" : "space-y-2"} ${isExiting ? "opacity-80" : ""} ${
        isEditingThisSection ? "" : "cursor-grab active:cursor-grabbing"
      }`}
      {...attributes}
      {...listeners}
      tabIndex={-1}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleCollapsed}
          className="btn-ghost inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition"
          aria-label={isCollapsed ? ui.studio.expandSection : ui.studio.collapseSection}
          title={isCollapsed ? ui.studio.expandSection : ui.studio.collapseSection}
        >
          <Icon name="arrow-right" className={`h-4 w-4 transition ${isCollapsed ? "" : "rotate-90"}`} />
        </button>

        <div className="min-w-0 flex-1">
          {isEditingThisSection ? (
            <input
              autoFocus
              value={editingSectionName}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onEditingSectionNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onConfirmRenameSection(section);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onCancelRenameSection();
                }
              }}
              className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-card)] px-3 py-1 text-sm text-[var(--theme-text)]"
            />
          ) : (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={toggleCollapsed}
              className="block w-full truncate text-left text-sm font-semibold uppercase tracking-[0.14em] text-[var(--theme-muted)] transition hover:text-[var(--theme-text)]"
              aria-label={isCollapsed ? ui.studio.expandSection : ui.studio.collapseSection}
              title={isCollapsed ? ui.studio.expandSection : ui.studio.collapseSection}
            >
              {section.name}
            </button>
          )}
        </div>

        {isEditingLibrary ? (
          <div className="flex shrink-0 gap-2">
            {isEditingThisSection ? (
              <>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onConfirmRenameSection(section);
                  }}
                  className="btn-accent inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)]"
                  aria-label={ui.studio.save}
                  title={ui.studio.save}
                >
                  <Icon name="check" className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelRenameSection();
                  }}
                  className="btn-ghost inline-flex h-8 w-8 items-center justify-center rounded-full transition"
                  aria-label={ui.studio.cancel}
                  title={ui.studio.cancel}
                >
                  <Icon name="close" className="h-4 w-4" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onStartRenameSection(section);
                }}
                className="btn-accent inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)]"
                aria-label={ui.studio.renameSection}
                title={ui.studio.renameSection}
              >
                <Icon name="edit" className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteSection(section);
              }}
              className="btn-ghost inline-flex h-8 w-8 items-center justify-center rounded-full transition"
              aria-label={ui.studio.deleteSection}
              title={ui.studio.deleteSection}
            >
              <Icon name="trash" className="h-4 w-4" />
            </button>
          </div>
        ) : null}
      </div>

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
        }`}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && isCollapsed) setShouldRenderTracks(false);
        }}
      >
        <div className={`min-h-0 overflow-hidden ${isCollapsed ? "pointer-events-none" : ""}`}>
          {renderTracks ? (
            <SortableContext items={tracks.map((track) => libraryTrackSortId(track.id))} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {tracks.length === 0 ? (
                  showEmptyDropSlot ? (
                    <div className="ml-5 h-12 rounded-2xl border border-dashed border-[var(--theme-accent-60)] bg-[var(--theme-queue-temp)]" />
                  ) : (
                    <div className="ml-5 rounded-2xl border border-dashed border-[var(--theme-border)] px-4 py-3 text-sm text-[var(--theme-muted)]">
                      {ui.studio.sectionEmpty}
                    </div>
                  )
                ) : (
                  tracks.map((track) => (
                    <LibraryItem
                      key={track.id}
                      track={track}
                      nested
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
                  ))
                )}
              </div>
            </SortableContext>
          ) : null}
        </div>
      </div>
    </section>
  );
}
