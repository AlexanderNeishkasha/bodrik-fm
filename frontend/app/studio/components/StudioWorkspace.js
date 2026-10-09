import {
  DndContext,
  DragOverlay,
} from "@dnd-kit/core";
import { restrictToWindowEdges } from "@dnd-kit/modifiers";
import AccountModal from "./AccountModal";
import DeleteModal from "./DeleteModal";
import StudioScreen from "./StudioScreen";
import Toast from "./Toast";

export default function StudioWorkspace({
  sensors,
  handleDragStart,
  handleDragOver,
  handleDragEnd,
  handleDragCancel,
  activeDrag,
  displayName,
  auth,
  playback,
  queue,
  library,
  theme,
  hotkeys,
  easter,
  deleteTarget,
  onCancelDelete,
  onConfirmDelete,
  isDeleteBusy,
  notice,
}) {
  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      modifiers={[restrictToWindowEdges]}
    >
      <>
        <StudioScreen
          auth={auth}
          playback={playback}
          queue={queue}
          library={library}
          theme={theme}
          hotkeys={hotkeys}
          easter={easter}
          isDndActive={Boolean(activeDrag)}
        />
        <DeleteModal
          deleteTarget={deleteTarget}
          onCancel={onCancelDelete}
          onConfirm={onConfirmDelete}
          isBusy={isDeleteBusy}
        />
        <AccountModal account={auth.account} login={auth.login} />
        <Toast notice={notice} />
        <DragOverlay adjustScale={false} dropAnimation={null}>
          {activeDrag?.data?.current ? (
            <div className="panel-shadow-drag pointer-events-none max-w-[260px] cursor-grabbing rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] px-4 py-2 text-sm text-[var(--theme-text)]">
              {displayName(activeDrag.data.current.filename)}
            </div>
          ) : null}
        </DragOverlay>
      </>
    </DndContext>
  );
}
