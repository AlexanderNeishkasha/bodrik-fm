import { useCallback, useEffect, useRef, useState } from "react";

/** Own one auto-expiring Studio notice and its timer cleanup. */
export default function useStudioNotice() {
  const [notice, setNotice] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  /** Replace the visible notice and restart its expiry timer. */
  const showNotice = useCallback((text) => {
    if (!text) return;
    setNotice(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setNotice(null);
      timerRef.current = null;
    }, 2500);
  }, []);

  return { notice, showNotice };
}
