import { createVideoVisibility } from "./videoVisibility.mjs";
import { createIceConfiguration } from "./iceConfig.mjs";

/** Header extension the legacy client strips before loading the device. */
const VIDEO_ORIENTATION = "urn:3gpp:video-orientation";

/** Failed consumes are retried this many times, with a growing delay. */
const MAX_CONSUME_ATTEMPTS = 5;
const CONSUME_RETRY_MS = 1000;

/** ICE restarts after a transport disconnects: 1s, 2s, 4s, 8s, 16s backoff. */
const ICE_RESTART_ATTEMPTS = 5;
const ICE_RESTART_DELAY_MS = 1000;

/** Registry source kinds mapped to Rust media types. */
const MEDIA_TYPE_BY_KIND = Object.freeze({ audio: "audioType", camera: "videoType", screen: "screenType" });

/** Load mediasoup-client lazily so importing this module never touches browser APIs. */
async function loadDevice() {
  const { Device } = await import("mediasoup-client");
  return new Device();
}

/**
 * Own the mediasoup device, one send and one receive transport, local producers and
 * remote consumers. `reconcile(state)` is idempotent: it consumes every remote producer
 * once and closes consumers whose producer disappeared. Tracks are exposed by producer id.
 */
export function createMeetingMedia({ command, createDevice = loadDevice, onTracksChanged, onTransportFailed, setTimer = setTimeout,
  clearTimer = clearTimeout, now = Date.now, random = Math.random }) {
  let device = null;
  let sendTransport = null;
  let recvTransport = null;
  let closed = false;
  let lastState = null;
  const consumers = new Map(); // producerId -> consumer
  const consuming = new Set(); // producerIds with an in-flight consume
  const producers = new Map(); // producerId -> local producer
  const failures = new Map(); // producerId -> failed consume attempts
  let queue = Promise.resolve();
  const visibility = createVideoVisibility({ apply: updateVideoVisibility, schedule: setTimer });
  const ice = createIceConfiguration({ command, setTimer, clearTimer, now, random, onFailure: onTransportFailed,
    apply: async ({ iceServers }) => {
      if (closed) return;
      for (const transport of [sendTransport, recvTransport]) {
        if (transport && !transport.closed) await transport.updateIceServers({ iceServers });
        if (closed) return;
      }
    },
  });

  /** Pause forwarding before disabling decoding; resume the same retained track. */
  async function updateVideoVisibility(id, visible) {
    const consumer = consumers.get(id);
    if (!consumer || consumer.kind !== "video" || closed) return;
    try {
      await media(visible ? "resumeConsumer" : "pauseConsumer", { consumerId: consumer.id });
      if (closed || consumers.get(id) !== consumer) return;
      if (visibility.visible(id)) consumer.resume();
      else consumer.pause();
    } catch {
      if (!closed) onTransportFailed?.();
    }
  }

  /** Run media commands one at a time: the native worker rejects concurrent ones as busy. */
  function media(operation, payload) {
    const run = queue.then(() => command({ type: "media", operation: { operation, payload } }));
    queue = run.catch(() => {});
    return run;
  }

  /** Wire the DTLS connect handshake and ICE recovery for one transport. */
  function connectHandler(transport) {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      media("connectTransport", { transportId: transport.id, dtlsParameters }).then(() => callback(), errback);
    });
    let restarting = false;
    transport.on("connectionstatechange", async (state) => {
      if (closed) return;
      if (state === "failed") {
        onTransportFailed?.();
        return;
      }
      if (state !== "disconnected" || restarting) return;
      restarting = true;
      const recovered = await restartIce(transport);
      restarting = false;
      if (!recovered && !closed) onTransportFailed?.();
    });
  }

  /** Restart ICE with exponential backoff; resolves whether the transport recovered. */
  async function restartIce(transport) {
    for (let attempt = 0; attempt < ICE_RESTART_ATTEMPTS; attempt++) {
      if (closed || transport.closed) return false;
      try {
        await ice.refresh();
        if (closed || transport.closed) return false;
        const iceParameters = await media("restartIce", { transportId: transport.id });
        await transport.restartIce({ iceParameters });
        return true;
      } catch {
        await new Promise((resolve) => setTimer(resolve, ICE_RESTART_DELAY_MS * 2 ** attempt));
      }
    }
    return false;
  }

  /** Consume one remote producer and attach its track. */
  async function consume(producerId, kind) {
    consuming.add(producerId);
    try {
      const value = await media("consume", {
        transportId: recvTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities,
        mediaType: MEDIA_TYPE_BY_KIND[kind],
      });
      if (closed || value?.nativeError || !wanted(producerId)) return;
      const consumer = await recvTransport.consume({
        id: value.id,
        producerId,
        kind: value.kind,
        rtpParameters: value.rtpParameters,
      });
      if (closed || !wanted(producerId)) {
        consumer.close();
        return;
      }
      consumers.set(producerId, consumer);
      const drop = () => {
        if (consumers.get(producerId) !== consumer) return;
        consumers.delete(producerId);
        onTracksChanged?.();
      };
      consumer.on("trackended", drop);
      consumer.on("transportclose", drop);
      if (kind === "audio" || visibility.visible(producerId)) await media("resumeConsumer", { consumerId: consumer.id });
      else consumer.pause();
      failures.delete(producerId);
      onTracksChanged?.();
    } catch {
      retryLater(producerId);
    } finally {
      consuming.delete(producerId);
    }
  }

  /** Retry a failed consume a bounded number of times. */
  function retryLater(producerId) {
    const attempts = (failures.get(producerId) || 0) + 1;
    failures.set(producerId, attempts);
    if (attempts > MAX_CONSUME_ATTEMPTS) return;
    setTimer(() => {
      if (!closed && lastState && wanted(producerId)) api.reconcile(lastState);
    }, CONSUME_RETRY_MS * attempts);
  }

  /** Whether the latest state still has this remote producer. */
  function wanted(producerId) {
    const value = lastState?.producers[producerId];
    return Boolean(value && value.participantId !== lastState.selfId);
  }

  const api = {
    /** Load the device and create both transports. Call once after admission. */
    async start() {
      const iceSettings = await ice.refresh();
      const capabilities = await media("capabilities", {});
      const routerRtpCapabilities = {
        ...capabilities,
        headerExtensions: (capabilities.headerExtensions || []).filter((ext) => ext.uri !== VIDEO_ORIENTATION),
      };
      device = await createDevice();
      await device.load({ routerRtpCapabilities });
      const sendOptions = await media("createTransport", {});
      if (closed) return;
      sendTransport = device.createSendTransport({ ...sendOptions, ...iceSettings });
      connectHandler(sendTransport);
      sendTransport.on("produce", ({ kind, appData, rtpParameters }, callback, errback) => {
        media("produce", { transportId: sendTransport.id, kind, mediaType: appData.mediaType, rtpParameters })
          .then((value) => callback({ id: value.producerId }), errback);
      });
      const recvOptions = await media("createTransport", {});
      if (closed) return;
      recvTransport = device.createRecvTransport({ ...recvOptions, ...iceSettings });
      connectHandler(recvTransport);
      if (lastState) api.reconcile(lastState);
    },

    /** Refresh credentials after signaling recovery while retaining existing media tracks. */
    refreshIceConfig: () => ice.refresh(),

    /** Bring consumers in line with the remote producers in `state`. */
    reconcile(state) {
      lastState = state;
      visibility.retain(Object.keys(state.producers));
      if (!recvTransport || closed) return;
      for (const [producerId, value] of Object.entries(state.producers)) {
        if (value.participantId === state.selfId) continue;
        if (consumers.has(producerId) || consuming.has(producerId)) continue;
        if ((failures.get(producerId) || 0) > MAX_CONSUME_ATTEMPTS) continue;
        consume(producerId, value.kind);
      }
      let changed = false;
      for (const [producerId, consumer] of consumers) {
        if (wanted(producerId)) continue;
        consumers.delete(producerId);
        consumer.close();
        changed = true;
      }
      if (changed) onTracksChanged?.();
    },

    /** Publish one local track; resolves with the server producer id. */
    async publish(track, kind) {
      // Capture owns track lifetime: closing a producer (leave, readmission) must not stop it.
      const producer = await sendTransport.produce({ track, stopTracks: false, appData: { mediaType: MEDIA_TYPE_BY_KIND[kind] } });
      producers.set(producer.id, producer);
      return producer.id;
    },

    /** Pause or resume one local producer on the server and locally. */
    async setPaused(producerId, paused) {
      const producer = producers.get(producerId);
      if (!producer) return;
      await media(paused ? "pauseProducer" : "resumeProducer", { producerId });
      if (paused) producer.pause();
      else producer.resume();
    },

    /** Swap the track of one local producer without renegotiation. */
    async replaceTrack(producerId, track) {
      await producers.get(producerId)?.replaceTrack({ track });
      onTracksChanged?.();
    },

    /** Close one local producer on the server and locally. */
    async unpublish(producerId) {
      const producer = producers.get(producerId);
      if (!producer) return;
      producers.delete(producerId);
      producer.close();
      await media("closeProducer", { producerId }).catch(() => {});
    },

    /** Report actual viewport visibility without closing or replacing tracks. */
    setVideoVisible: (id, visible) => visibility.set(id, visible),

    /** Track for a producer id: local producer track or remote consumer track. */
    trackFor(producerId) {
      return producers.get(producerId)?.track || consumers.get(producerId)?.track || null;
    },

    /** Close all media resources. Capture tracks are owned by the caller. */
    close() {
      closed = true;
      ice.close();
      visibility.close();
      for (const consumer of consumers.values()) consumer.close();
      for (const producer of producers.values()) producer.close();
      consumers.clear();
      producers.clear();
      sendTransport?.close();
      recvTransport?.close();
    },
  };
  return api;
}
