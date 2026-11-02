"use client";

import { useEffect, useRef } from "react";
import { createPushToTalk } from "../client/pushToTalk.mjs";

/** Bind the hold-to-talk owner to the microphone button and this room's lifecycle. */
export function usePushToTalk({ client, enabled, onError }) {
  const talk = useRef(null);
  const reportError = useRef(onError);
  useEffect(() => { reportError.current = onError; }, [onError]);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = createPushToTalk({ client, onError: (error) => reportError.current?.(error) });
    talk.current = controller;
    return () => { talk.current = null; controller.dispose(); };
  }, [client, enabled]);

  /** Capture the pointer so dragging off the button still delivers its release. */
  function pointerDown(event) {
    if (!enabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    talk.current?.press(`pointer-${event.pointerId}`);
  }

  /** Pointer release, cancellation and lost capture all close the same input. */
  function pointerUp(event) {
    talk.current?.release(`pointer-${event.pointerId}`);
  }

  /** Support keyboard activation while the microphone button itself is focused. */
  function keyDown(event) {
    if (!enabled || event.defaultPrevented || !["Space", "Enter"].includes(event.code)) return;
    event.preventDefault();
    if (!event.repeat) talk.current?.press("button");
  }

  /** Release focused-button activation independently of the global Space binding. */
  function keyUp(event) {
    if (!["Space", "Enter"].includes(event.code)) return;
    talk.current?.release("button");
  }

  /** Moving focus off the button cannot leave its keyboard input held. */
  function blur() {
    talk.current?.release("button");
  }

  return { onPointerDown: pointerDown, onPointerUp: pointerUp, onPointerCancel: pointerUp,
    onLostPointerCapture: pointerUp, onKeyDown: keyDown, onKeyUp: keyUp, onBlur: blur };
}
