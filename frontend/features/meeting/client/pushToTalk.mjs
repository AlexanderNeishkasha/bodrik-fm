/** Whether a keyboard event belongs to text entry or an input/select control. */
function editable(event) {
  return (event.composedPath?.() || [event.target]).some((element) => element?.nodeType === 1
    && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
      || element.getAttribute?.("role") === "textbox"));
}

/**
 * Own hold-to-talk inputs and serialize microphone commands. Release on focus loss,
 * hidden tabs and disposal; pending presses cannot win over a later release.
 */
export function createPushToTalk({ client, windowRef = globalThis.window, documentRef = globalThis.document, onError }) {
  const held = new Set();
  let disposed = false;
  let desired = true;
  let applied = null;
  let running = false;
  let producerId = "";

  /** Apply the latest desired mute state without overlapping signaling commands. */
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (applied !== desired) {
        const muted = desired;
        const currentProducer = producerId;
        await client.setMicrophoneMuted(muted);
        applied = currentProducer === producerId ? muted : null;
        const track = client.capture?.track("audio");
        if (track) track.enabled = !desired;
      }
    } catch (error) {
      held.clear();
      desired = true;
      const track = client.capture?.track("audio");
      if (track) track.enabled = false;
      onError?.(error);
      try {
        await client.setMicrophoneMuted(true);
        applied = true;
      } catch (muteError) {
        onError?.(muteError);
      }
    } finally {
      running = false;
    }
  }

  /** Publish the desired state after any input changes. */
  function update() {
    desired = disposed || held.size === 0;
    const track = client.capture?.track("audio");
    if (desired && track) track.enabled = false;
    void pump();
  }

  /** Hold one input; other simultaneously held inputs remain authoritative. */
  function press(input) {
    if (disposed) return;
    held.add(input);
    update();
  }

  /** Release one input without cancelling another held input. */
  function release(input) {
    held.delete(input);
    update();
  }

  /** Focus loss must not leave the microphone transmitting. */
  function releaseAll() {
    held.clear();
    update();
  }

  /** Capture Space before focused buttons; held repeats must not trigger native activation. */
  function keydown(event) {
    if (event.code !== "Space" || event.ctrlKey || event.altKey || event.metaKey
      || event.isComposing || event.defaultPrevented || editable(event)) return;
    event.preventDefault();
    if (!event.repeat) press("keyboard");
  }

  /** Always release a held key, even if focus moved into an editor after keydown. */
  function keyup(event) {
    if (event.code !== "Space" || !held.has("keyboard")) return;
    event.preventDefault();
    release("keyboard");
  }

  /** Backgrounding a tab releases every input. */
  function visibility() {
    if (documentRef?.hidden) releaseAll();
  }

  /** New admission/producer must inherit the hold-to-talk mute state. */
  function refreshProducer() {
    const state = client.getState();
    const next = Object.values(state.producers).find((value) => value.participantId === state.selfId && value.kind === "audio")?.id || "";
    if (next === producerId) return;
    producerId = next;
    applied = null;
    releaseAll();
  }

  windowRef?.addEventListener("keydown", keydown, true);
  windowRef?.addEventListener("keyup", keyup, true);
  windowRef?.addEventListener("blur", releaseAll);
  documentRef?.addEventListener("visibilitychange", visibility);
  const unsubscribe = client.subscribe(refreshProducer);
  refreshProducer();
  update();
  return {
    press,
    release,
    /** Unbind input listeners and settle the microphone in the muted state. */
    dispose() {
      disposed = true;
      windowRef?.removeEventListener("keydown", keydown, true);
      windowRef?.removeEventListener("keyup", keyup, true);
      windowRef?.removeEventListener("blur", releaseAll);
      documentRef?.removeEventListener("visibilitychange", visibility);
      unsubscribe();
      releaseAll();
    },
  };
}
