"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import { bindMediaTrack } from "./mediaTrackBinding.mjs";
import { playbackVolume } from "./playbackVolume.mjs";

/** No per-peer volumes. */
const none = Object.freeze({});

/** Subscription used without a layout store. */
function noop() {
  return () => {};
}

/** Play one remote audio track; the element never owns the track lifetime. */
function RemoteAudio({ registry, sourceId, outputDevice, volume }) {
  const ref = useRef(null);
  const readTrack = () => registry.getTrack(sourceId);
  const track = useSyncExternalStore(registry.subscribe, readTrack, readTrack);
  useEffect(() => {
    const element = ref.current;
    if (!element || !track || typeof MediaStream === "undefined") return undefined;
    return bindMediaTrack(element, track);
  }, [track]);
  // Per-participant playback volume chosen by this viewer.
  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume]);
  // Route playback to the selected speaker where the browser supports it.
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof element.setSinkId !== "function") return;
    element.setSinkId(outputDevice || "").catch(() => {});
  }, [outputDevice]);
  return <audio ref={ref} autoPlay />;
}

/** Render one hidden audio element per remote audio source in the registry. */
export default function MeetingAudio({ registry, outputDevice = "", layout, masterVolume = 100, musicVolume = 1 }) {
  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const volumes = useSyncExternalStore(layout?.subscribe ?? noop, () => layout?.getSnapshot().volumes ?? none, () => none);
  const sources = snapshot.sources.filter((source) => source.kind === "audio" && !source.local);
  return <div hidden>
    {sources.map((source) => <RemoteAudio key={source.id} registry={registry} sourceId={source.id} outputDevice={outputDevice}
      volume={playbackVolume(source.participantId, volumes, masterVolume, musicVolume)} />)}
  </div>;
}
