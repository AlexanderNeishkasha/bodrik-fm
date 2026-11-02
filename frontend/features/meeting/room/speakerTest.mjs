import { assetUrl } from "../../../app/lib/asset.js";

/** Own one speaker-test melody, routing it to the selected output and releasing it on stop. */
export function createSpeakerTest({ createAudio = (url) => new Audio(url), volume = () => 1 } = {}) {
  let current = null;
  const listeners = new Set();
  /** Publish playback ownership without duplicating media state. */
  function publish() { for (const listener of [...listeners]) listener(); }
  /** Release playback on completion, replacement, failure or meeting leave. */
  function stop() {
    const audio = current;
    current = null;
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    publish();
  }
  return {
    stop,
    getSnapshot: () => current !== null,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    /** Apply the current master volume to already-playing test audio. */
    syncVolume() { if (current) current.volume = 0.5 * volume(); },
    /** Play the original melody; output-routing failures remain visible to the caller. */
    async play(outputDevice) {
      stop();
      const audio = createAudio(assetUrl("/meeting-assets/sounds/speaker.wav"));
      current = audio;
      audio.volume = 0.5 * volume();
      publish();
      /** Ignore callbacks from replaced playback. */
      const release = () => { if (current === audio) stop(); };
      audio.onended = release;
      audio.onerror = release;
      try {
        if (outputDevice && typeof audio.setSinkId === "function") await audio.setSinkId(outputDevice);
        if (current !== audio) return;
        await audio.play();
      } catch (error) {
        if (current !== audio) return;
        stop();
        throw error;
      }
    },
  };
}

/** Room statuses during which a speaker test may keep playing. */
const IN_ROOM = new Set(["admitted", "reconnecting"]);

/**
 * Stop the melody when the client leaves the room by any path (exit button, kick, failure),
 * not only when the whole session is released. Returns an unsubscribe function.
 */
export function stopOnRoomExit(client, speakerTest) {
  let inRoom = IN_ROOM.has(client.getState().status);
  return client.subscribe(() => {
    const next = IN_ROOM.has(client.getState().status);
    if (inRoom && !next) speakerTest.stop();
    inRoom = next;
  });
}
