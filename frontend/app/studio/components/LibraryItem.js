import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ui } from "../../lang/ru";
import Icon from "../../components/Icon";
import HighlightedSongName from "./HighlightedSongName";

/** Render a draggable song; search matches remain drag sources but never library drop targets. */
export default function LibraryItem({
  track,
  isEditingLibrary,
  editingTrackId,
  editingValue,
  onEditValueChange,
  onStartRename,
  onCancelRename,
  onConfirmRename,
  onRequestDelete,
  onPlay,
  onQueue,
  displayName,
  searchQuery = "",
  nested = false,
  isExiting = false,
}) {
  const isSearchResult = searchQuery.trim().length > 0;
  const isEditingTrackName = !isExiting && isEditingLibrary && editingTrackId === track.id;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `library-track-${track.id}`,
    data: {
      type: "library",
      id: track.id,
      filename: track.filename,
      sectionId: track.section_id ?? null,
      libraryReadOnly: isSearchResult,
    },
    disabled: {
      draggable: isEditingTrackName || isExiting,
      droppable: isSearchResult || isEditingTrackName || isExiting,
    },
  });
  const style = isDragging || isSearchResult
    ? undefined
    : {
        transform: CSS.Transform.toString(transform),
        transition,
      };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center justify-between gap-3 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] py-3 touch-none ${
        nested ? "ml-5 px-4" : "px-4"
      } ${
        isEditingTrackName ? "" : "cursor-grab active:cursor-grabbing"
      } ${isDragging ? "opacity-20 cursor-grabbing" : ""}`}
      {...attributes}
      {...listeners}
      tabIndex={-1}
    >
      <div className="flex min-w-0 flex-1 items-center">
        {isEditingTrackName ? (
          <input
            autoFocus
            value={editingValue}
            onChange={(event) => onEditValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onConfirmRename(track);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancelRename();
              }
            }}
            className="w-full rounded-full border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-3 py-1 text-sm text-[var(--theme-text)]"
          />
        ) : (
          <span className="truncate text-[var(--theme-text)]">
            <HighlightedSongName name={displayName(track.filename)} query={searchQuery} />
          </span>
        )}
      </div>
      <div className="flex shrink-0 gap-2 text-xs uppercase tracking-[0.2em] whitespace-nowrap">
        {isEditingLibrary ? (
          <>
            {editingTrackId === track.id ? (
              <>
                <button
                  disabled={isExiting}
                  onClick={(event) => {
                    event.stopPropagation();
                    onConfirmRename(track);
                  }}
                  className="btn-accent inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)]"
                  aria-label={ui.studio.save}
                  title={ui.studio.save}
                >
                  <Icon name="check" className="h-4 w-4" />
                </button>
                <button
                  disabled={isExiting}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelRename();
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
                disabled={isExiting}
                onClick={(event) => {
                  event.stopPropagation();
                  onStartRename(track);
                }}
                className="btn-accent inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)]"
                aria-label={ui.studio.rename}
                title={ui.studio.rename}
              >
                <Icon name="edit" className="h-4 w-4" />
              </button>
            )}
            <button
              disabled={isExiting}
              onClick={(event) => {
                event.stopPropagation();
                onRequestDelete(track);
              }}
              className="btn-ghost inline-flex h-8 w-8 items-center justify-center rounded-full transition"
              aria-label={ui.studio.delete}
              title={ui.studio.delete}
            >
              <Icon name="trash" className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <button
              disabled={isExiting}
              onClick={(event) => {
                event.stopPropagation();
                onPlay(track.id);
              }}
              className="btn-accent inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)]"
              aria-label={ui.studio.play}
              title={ui.studio.play}
            >
              <Icon name="play" className="h-4 w-4" />
            </button>
            <button
              disabled={isExiting}
              onClick={(event) => {
                event.stopPropagation();
                onQueue(track.id);
              }}
              className="btn-ghost inline-flex h-8 w-8 items-center justify-center rounded-full transition"
              aria-label={ui.studio.queueAction}
              title={ui.studio.queueAction}
            >
              <Icon name="queue-add" className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
