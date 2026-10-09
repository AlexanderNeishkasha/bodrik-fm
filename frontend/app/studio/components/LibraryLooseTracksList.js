import { useMemo } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import LibraryItem from "./LibraryItem";
import LibraryFadeItem from "./LibraryFadeItem";
import { libraryTrackSortId } from "./LibrarySection";
import { useLibraryPresence } from "../hooks/useLibraryPresence";

/** Keep keyed songs mounted across query edits and fade only additions/removals. */
export default function LibraryLooseTracksList({
  active,
  tracks,
  setLooseDropRef,
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
  emptyMessage,
}) {
  const isLibraryTrackDrag = active?.data?.current?.type === "library";
  const items = useMemo(() => {
    const rows = tracks.map(track => ({ key: `track:${track.id}`, track, searchQuery }));
    return emptyMessage ? [...rows, emptyMessage] : rows;
  }, [tracks, searchQuery, emptyMessage]);
  const { entries, reducedMotion, finishExit } = useLibraryPresence(items);

  return (
    <SortableContext
      items={tracks.map(track => libraryTrackSortId(track.id))}
      strategy={verticalListSortingStrategy}
    >
      <div
        ref={setLooseDropRef}
        className={`space-y-3 ${isLibraryTrackDrag && tracks.length === 0 ? "min-h-8" : ""}`}
      >
        {entries.map(entry => (
          <LibraryFadeItem
            key={entry.key}
            entryKey={entry.key}
            isExiting={entry.isExiting}
            reducedMotion={reducedMotion}
            onExited={finishExit}
          >
            {entry.track ? (
              <LibraryItem
                track={entry.track}
                isExiting={entry.isExiting}
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
                searchQuery={entry.searchQuery}
              />
            ) : <p role={entry.role} className="text-[var(--theme-muted)]">{entry.text}</p>}
          </LibraryFadeItem>
        ))}
      </div>
    </SortableContext>
  );
}
