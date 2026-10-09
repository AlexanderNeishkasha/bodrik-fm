"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { observeVideoViewport } from "./videoViewport.mjs";
import { bindMediaTrack } from "./mediaTrackBinding.mjs";

/** Attach a caller-owned visual track; rerenders and cleanup never own capture lifetime. */
export default function MediaTrack({ registry, source }) {
  const ref = useRef(null);
  // Subscribe so a track attached after the first render still reaches the element.
  const readTrack = () => registry.getTrack(source.id);
  const track = useSyncExternalStore(registry.subscribe, readTrack, readTrack);
  useEffect(() => {
    const element = ref.current;
    if (!element || !track || typeof MediaStream === "undefined") return undefined;
    return bindMediaTrack(element, track);
  }, [track]);
  const sourceId = source.id;
  const localSource = source.local;
  useEffect(() => observeVideoViewport(ref.current, { id: sourceId, local: localSource }, registry.setVideoVisible), [registry, sourceId, localSource]);
  // The local camera is shown mirrored (selfie view), as in the legacy meeting.
  const mirrored = source.local && source.kind === "camera";
  return <video ref={ref} autoPlay playsInline muted={source.local} style={mirrored ? { transform: "scaleX(-1)" } : undefined} />;
}
