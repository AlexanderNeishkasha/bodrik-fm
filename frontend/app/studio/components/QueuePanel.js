import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ui } from "../../lang/ru";
import Icon from "../../components/Icon";
import listStyles from "./StudioListPanel.module.css";

function QueueItem({ entry, onForcePlay, onRemove, displayName }) {
  const { id, item, index } = entry;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    data: {
      type: "queue",
      index,
      id: item.id,
      filename: item.filename,
    },
  });
  const style = isDragging
    ? undefined
    : {
        transform: CSS.Transform.toString(transform),
        transition,
      };

  const isTemp = Boolean(item.__temp);
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`touch-none flex items-center justify-between gap-3 rounded-2xl px-4 py-2 transition ${
        isTemp
          ? "border border-dashed border-[var(--theme-border)] bg-[var(--theme-queue-temp)] text-[var(--theme-muted)]"
          : "border border-[var(--theme-border)] bg-[var(--theme-card-2)]"
      } ${isDragging ? "opacity-20 cursor-grabbing" : "cursor-grab active:cursor-grabbing"}`}
      {...attributes}
      {...listeners}
      tabIndex={-1}
    >
      <span className="min-w-0 flex-1 truncate">
        {displayName(item.filename)}
      </span>
      {isTemp ? null : (
        <div className="flex shrink-0 gap-2">
          <button
            onClick={(event) => {
              event.stopPropagation();
              onForcePlay(index);
            }}
            className="btn-accent inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--theme-accent)] text-[var(--theme-text-dark)] transition hover:bg-[var(--theme-accent-bright)]"
            aria-label={ui.studio.forcePlay}
          >
            <Icon name="play" className="h-4 w-4" />
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onRemove(index);
            }}
            className="btn-ghost inline-flex h-8 w-8 items-center justify-center rounded-full transition"
            aria-label={ui.studio.removeFromQueue}
          >
            <Icon name="trash" className="h-4 w-4" />
          </button>
        </div>
      )}
    </li>
  );
}

export default function QueuePanel({
  queueEntries,
  queueIds,
  onForcePlay,
  onRemove,
  displayName,
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: "queue-container",
  });
  const hasItems = queueEntries.length > 0;
  return (
    <section
      className={`${listStyles.panel} panel-shadow-card min-w-0 space-y-6 rounded-[28px] border border-[var(--theme-border)] bg-[var(--theme-card)] p-8 ${
        isOver ? "ring-2 ring-[var(--theme-accent-60)]" : ""
      }`}
      ref={setNodeRef}
    >
      <h2 className="text-lg font-semibold font-display tracking-[0.08em]">
        {ui.studio.queue}
      </h2>
      {hasItems ? (
        <SortableContext items={queueIds} strategy={verticalListSortingStrategy}>
          <ol className="space-y-2 text-sm text-[var(--theme-text)]">
            {queueEntries.map((entry, renderIndex) => (
              <QueueItem
                key={`${entry.id}-${renderIndex}`}
                entry={entry}
                onForcePlay={onForcePlay}
                onRemove={onRemove}
                displayName={displayName}
              />
            ))}
          </ol>
        </SortableContext>
      ) : (
        <p className="text-sm text-[var(--theme-muted)]">{ui.studio.queueEmpty}</p>
      )}
    </section>
  );
}
