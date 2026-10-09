import { useEffect, useRef } from "react";
import runAudioPulse from "./audioPulseRuntime";

/** Bind committed media after each render; no frame loop polls the React ref. */
export default function useAudioPulse(audioRef, { enabled = true, unlocked = false } = {}) {
  const runtime = useRef(null);
  useEffect(() => {
    const controller = runAudioPulse({ enabled, unlocked });
    runtime.current = controller;
    controller.bind(audioRef.current);
    return () => {
      controller.dispose();
      if (runtime.current === controller) runtime.current = null;
    };
  }, [audioRef, enabled, unlocked]);
  useEffect(() => { runtime.current?.bind(audioRef.current); });
}
