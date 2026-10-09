import { useEffect } from "react";

const isEditableTarget = (target) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    target.isContentEditable ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT"
  );
};

const pressHotkeyButtons = (action, pressed) => {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const attr = `data-hotkey-pressed-${action}`;
  if (pressed) {
    root.setAttribute(attr, "true");
  } else {
    root.removeAttribute(attr);
  }
};

export default function useStudioHotkeys({
  isAuthed,
  setShowHotkeys,
  toggleEdit,
  stateIsPlaying,
  sendAction,
  toggleLocalMute,
  changeLocalVolume,
  unlockAudio,
  localMuted,
  localVolume,
  currentPosition,
  duration,
  seekValue,
  setSeekValue,
  isSeekingRef,
  scheduleSeek,
  onEaster,
}) {
  useEffect(() => {
    if (!isAuthed) {
      return undefined;
    }
    const handleKeydown = (event) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }
      if (event.code === "KeyH") {
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        pressHotkeyButtons("hotkeys", true);
        setShowHotkeys((prev) => !prev);
        onEaster?.();
      } else if (event.code === "KeyE") {
        event.preventDefault();
        toggleEdit();
        const toggleButton = document.querySelector(
          "[data-edit-toggle=\"true\"]"
        );
        if (toggleButton instanceof HTMLElement) {
          toggleButton.focus();
        }
      } else if (event.code === "Space") {
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        pressHotkeyButtons("playback", true);
        if (stateIsPlaying) {
          sendAction("/api/studio/pause");
        } else {
          unlockAudio();
          sendAction("/api/studio/resume");
        }
        onEaster?.();
      } else if (event.code === "KeyM") {
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        pressHotkeyButtons("mute", true);
        toggleLocalMute();
        onEaster?.();
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? -0.05 : 0.05;
        const next = Math.min(1, Math.max(0, localVolume + delta));
        if (delta > 0 && stateIsPlaying && (localMuted || localVolume === 0)) {
          unlockAudio({ volume: next, unmute: true });
          return;
        }
        changeLocalVolume(delta);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -5 : 5;
        const current =
          isSeekingRef.current ? Number(seekValue) : Number(currentPosition ?? 0);
        let next = current + direction;
        if (next < 0) {
          next = 0;
        }
        if (duration != null && next > duration) {
          next = duration;
        }
        setSeekValue(String(Math.floor(next)));
        scheduleSeek(next);
      }
    };
    const handleKeyup = (event) => {
      if (event.code === "Space") {
        pressHotkeyButtons("playback", false);
      } else if (event.code === "KeyM") {
        pressHotkeyButtons("mute", false);
      } else if (event.code === "KeyH") {
        pressHotkeyButtons("hotkeys", false);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("keyup", handleKeyup);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("keyup", handleKeyup);
    };
  }, [
    changeLocalVolume,
    currentPosition,
    duration,
    isAuthed,
    isSeekingRef,
    localMuted,
    localVolume,
    scheduleSeek,
    seekValue,
    sendAction,
    setSeekValue,
    setShowHotkeys,
    stateIsPlaying,
    toggleEdit,
    toggleLocalMute,
    unlockAudio,
    onEaster,
  ]);
}
