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

export default function useMainHotkeys({
  onTogglePause,
  onToggleMute,
  onAdjustVolume,
  onToggleHotkeys,
  onToggleHat,
  onEaster,
}) {
  useEffect(() => {
    const handleKeydown = (event) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }
      if (event.code === "Space") {
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        pressHotkeyButtons("playback", true);
        onTogglePause();
        onEaster?.();
      } else if (event.code === "KeyM") {
        if (event.repeat) {
          return;
        }
        pressHotkeyButtons("mute", true);
        onToggleMute();
        onEaster?.();
      } else if (event.code === "KeyH") {
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        pressHotkeyButtons("hotkeys", true);
        onToggleHotkeys();
        onEaster?.();
      } else if (event.code === "KeyB" && onToggleHat) {
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        onToggleHat();
      } else if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "ArrowLeft" ||
          event.key === "ArrowDown" ||
          event.key === "ArrowRight" ||
          event.key === "ArrowUp")
      ) {
        event.preventDefault();
        const delta =
          event.key === "ArrowLeft" || event.key === "ArrowDown"
            ? -0.05
            : 0.05;
        onAdjustVolume(delta);
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
  }, [onAdjustVolume, onToggleHat, onToggleHotkeys, onToggleMute, onTogglePause, onEaster]);
}
