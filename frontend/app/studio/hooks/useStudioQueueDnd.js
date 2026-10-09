import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useQueueDndHandlers from "../lib/queueDndHandlers";
import { buildQueueKeys, queueSignature } from "../lib/queueDndUtils.mjs";
import { deferEffect } from "../../lib/deferEffect";

export default function useStudioQueueDnd({
  queueFromState,
  sections,
  setSections,
  tracks,
  setTracks,
  applyLibraryPayload,
  isEditingLibrary,
  sendAction,
}) {
  const [activeDrag, setActiveDrag] = useState(null);
  const [queueIds, setQueueIds] = useState([]);
  const [localQueue, setLocalQueue] = useState([]);
  const queueIdCounter = useRef(0);
  const tempQueueIdRef = useRef(null);
  const tempTrackRef = useRef(null);
  const libraryDragSnapshotRef = useRef(null);
  const libraryPreviewTargetRef = useRef(null);
  const sectionDragSnapshotRef = useRef(null);
  const suppressSyncUntilRef = useRef(0);
  const pendingQueueRef = useRef(null);
  const syncedQueueSignatureRef = useRef("");
  const localQueueRef = useRef([]);
  const queueIdsRef = useRef([]);

  const nextQueueId = useCallback(() => {
    queueIdCounter.current += 1;
    return `queue-item-${queueIdCounter.current}`;
  }, []);

  const getTempQueueId = useCallback(() => tempQueueIdRef.current, []);
  const setTempQueueId = useCallback((value) => {
    tempQueueIdRef.current = value;
  }, []);
  const getTempTrack = useCallback(() => tempTrackRef.current, []);
  const setTempTrack = useCallback((value) => {
    tempTrackRef.current = value;
  }, []);
  /** Clear temporary queue preview identity and track state. */
  const clearTemp = useCallback(() => {
    tempQueueIdRef.current = null;
    tempTrackRef.current = null;
  }, []);

  useEffect(() => {
    localQueueRef.current = localQueue;
  }, [localQueue]);

  useEffect(() => {
    queueIdsRef.current = queueIds;
  }, [queueIds]);

  useEffect(() => deferEffect(() => {
    if (!queueFromState) {
      syncedQueueSignatureRef.current = "";
      setLocalQueue((prev) => (prev.length > 0 ? [] : prev));
      setQueueIds((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    if (activeDrag) {
      return;
    }
    const incoming = queueSignature(queueFromState);
    if (pendingQueueRef.current) {
      const pending = queueSignature(pendingQueueRef.current);
      if (incoming === pending) {
        pendingQueueRef.current = null;
        suppressSyncUntilRef.current = 0;
      } else if (Date.now() < suppressSyncUntilRef.current) {
        return;
      }
    } else if (Date.now() < suppressSyncUntilRef.current) {
      return;
    }
    if (incoming === syncedQueueSignatureRef.current) {
      return;
    }
    const prevKeys = buildQueueKeys(localQueueRef.current);
    const prevMap = new Map(
      prevKeys.map((key, index) => [key, queueIdsRef.current[index]])
    );
    const nextKeys = buildQueueKeys(queueFromState);
    const nextIds = nextKeys.map((key) => prevMap.get(key) ?? nextQueueId());
    syncedQueueSignatureRef.current = incoming;
    setLocalQueue((prev) =>
      queueSignature(prev) === incoming ? prev : queueFromState
    );
    setQueueIds((prev) => {
      if (
        prev.length === nextIds.length &&
        prev.every((value, index) => value === nextIds[index])
      ) {
        return prev;
      }
      return nextIds;
    });
  }), [queueFromState, activeDrag, nextQueueId]);

  const renderQueueIds = useMemo(() => {
    if (queueIds.length === localQueue.length) {
      return queueIds;
    }
    const next = [];
    for (let i = 0; i < localQueue.length; i += 1) {
      next.push(queueIds[i] ?? `queue-temp-${i}`);
    }
    return next;
  }, [queueIds, localQueue.length]);

  const queueEntries = useMemo(() => {
    const items = localQueue.map((item, index) => ({
      kind: "item",
      item,
      index,
      id: renderQueueIds[index],
    }));
    return items.filter((entry) => entry.item);
  }, [localQueue, renderQueueIds]);

  const {
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  } = useQueueDndHandlers({
    setActiveDrag,
    sections,
    setSections,
    tracks,
    setTracks,
    applyLibraryPayload,
    isEditingLibrary,
    queueIds,
    localQueue,
    setLocalQueue,
    setQueueIds,
    getTempQueueId,
    setTempQueueId,
    getTempTrack,
    setTempTrack,
    clearTemp,
    nextQueueId,
    pendingQueueRef,
    suppressSyncUntilRef,
    libraryDragSnapshotRef,
    libraryPreviewTargetRef,
    sectionDragSnapshotRef,
    sendAction,
  });

  return {
    activeDrag,
    queueEntries,
    renderQueueIds,
    localQueue,
    setLocalQueue,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  };
}
