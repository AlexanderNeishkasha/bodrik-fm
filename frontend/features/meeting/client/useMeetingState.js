"use client";

import { useSyncExternalStore } from "react";

import { initialRoomState } from "./roomState.mjs";

/** Server render has no client; it always sees the initial state. */
const serverState = () => initialRoomState;

/** Read the current meeting client state; `client` may be null before creation. */
export function useMeetingState(client) {
  return useSyncExternalStore(
    client ? client.subscribe : noopSubscribe,
    client ? client.getState : serverState,
    serverState,
  );
}

/** Subscription used while no client exists. */
function noopSubscribe() {
  return () => {};
}

/** Capture snapshot used before a client exists and during server render. */
const emptyCapture = Object.freeze({ outputDevice: "" });

/** Read the client's capture snapshot (devices, preferences, live kinds). */
export function useCaptureState(client) {
  const capture = client?.capture;
  return useSyncExternalStore(
    capture ? capture.subscribe : noopSubscribe,
    capture ? capture.getSnapshot : () => emptyCapture,
    () => emptyCapture,
  );
}
