import { useEffect, useRef } from "react";

export default function useStudioSeek({
  isSeekingRef,
  setSeekValue,
  sendAction,
}) {
  const seekDebounceRef = useRef(null);
  const pendingSeekRef = useRef(null);

  const scheduleSeek = (position) => {
    pendingSeekRef.current = position;
    isSeekingRef.current = true;
    if (seekDebounceRef.current) {
      clearTimeout(seekDebounceRef.current);
    }
    seekDebounceRef.current = setTimeout(() => {
      if (pendingSeekRef.current == null) {
        return;
      }
      const target = pendingSeekRef.current;
      pendingSeekRef.current = null;
      Promise.resolve(sendAction("/api/studio/seek", { position: target })).finally(
        () => {
          isSeekingRef.current = false;
        }
      );
    }, 1000);
  };

  const onSeek = (value) => {
    isSeekingRef.current = false;
    setSeekValue(String(value));
    sendAction("/api/studio/seek", { position: Number(value) });
  };

  useEffect(() => {
    return () => {
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current);
      }
    };
  }, []);

  return { scheduleSeek, onSeek };
}
