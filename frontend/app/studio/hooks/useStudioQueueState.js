import { PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import useStudioQueueDnd from "./useStudioQueueDnd";

export default function useStudioQueueState({
  queueFromState,
  sections,
  setSections,
  tracks,
  setTracks,
  applyLibraryPayload,
  isEditingLibrary,
  sendAction,
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  const {
    activeDrag,
    queueEntries,
    renderQueueIds,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  } = useStudioQueueDnd({
    queueFromState,
    sections,
    setSections,
    tracks,
    setTracks,
    applyLibraryPayload,
    isEditingLibrary,
    sendAction,
  });

  return {
    sensors,
    activeDrag,
    queueEntries,
    renderQueueIds,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  };
}
