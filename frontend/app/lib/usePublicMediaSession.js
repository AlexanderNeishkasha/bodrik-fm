import { useEffect } from "react";

/** Bind OS/browser media-session play and pause commands to local public audio. */
export default function usePublicMediaSession({
  audioRef,
  isPlaying,
  resumeFromFreshPosition,
  userPausedRef,
  setIsLocalPaused,
}) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

    /** Pause only the listener's local audio. */
    const handlePause = () => {
      const audio = audioRef.current;
      if (!audio) return;
      userPausedRef.current = true;
      audio.pause();
      setIsLocalPaused(true);
    };

    /** Resume from current backend authority when the room is playing. */
    const handlePlay = () => {
      if (!isPlaying) {
        userPausedRef.current = false;
        setIsLocalPaused(false);
        return;
      }
      resumeFromFreshPosition();
    };

    try {
      navigator.mediaSession.setActionHandler("pause", handlePause);
      navigator.mediaSession.setActionHandler("play", handlePlay);
    } catch {
      return;
    }

    return () => {
      try {
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("play", null);
      } catch {}
    };
  }, [audioRef, isPlaying, resumeFromFreshPosition, setIsLocalPaused, userPausedRef]);
}
