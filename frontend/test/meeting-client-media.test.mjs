import assert from "node:assert/strict";
import { test } from "node:test";

import { createMeetingMedia } from "../features/meeting/client/media.mjs";

/** Fake mediasoup consumer/producer with close and event hooks. */
function resource(id, kind) {
  const listeners = {};
  return {
    id,
    kind,
    track: { id: `track-${id}`, kind },
    closed: false,
    paused: false,
    on(name, listener) {
      listeners[name] = listener;
    },
    emit(name) {
      listeners[name]?.();
    },
    close() {
      this.closed = true;
    },
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
  };
}

/** Fake transport with the mediasoup event/consume/produce surface used by media.mjs. */
function transport(id) {
  const listeners = {};
  return {
    id,
    consumers: [],
    on(name, listener) {
      listeners[name] = listener;
    },
    async consume({ id: consumerId, kind }) {
      const consumer = resource(consumerId, kind);
      this.consumers.push(consumer);
      return consumer;
    },
    async produce({ appData, stopTracks }) {
      this.stopTracks = stopTracks;
      return new Promise((resolve, reject) => {
        listeners.produce({ kind: "audio", appData, rtpParameters: {} }, ({ id: producerId }) => resolve(resource(producerId, "audio")), reject);
      });
    },
    close() {},
    async updateIceServers(options) { this.iceUpdate = options; },
  };
}

/** Build media with a scripted command function that records order and concurrency. */
function setup({ failConsume = () => false, iceConfig = { iceServers: [], iceTransportPolicy: "all", expiresAt: null } } = {}) {
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const timers = [];
  const command = async (action) => {
    if (action.type === "iceConfig") return iceConfig;
    const { operation, payload } = action.operation;
    calls.push(operation);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running -= 1;
    if (operation === "capabilities") return { codecs: [], headerExtensions: [{ uri: "urn:3gpp:video-orientation" }, { uri: "keep" }] };
    if (operation === "createTransport") return { id: `t${calls.filter((value) => value === "createTransport").length}` };
    if (operation === "consume") {
      if (failConsume(payload.producerId)) throw Object.assign(new Error("busy"), { code: "busy" });
      return { id: `c-${payload.producerId}`, kind: payload.mediaType === "audioType" ? "audio" : "video", rtpParameters: {} };
    }
    if (operation === "produce") return { producerId: "own-1" };
    return {};
  };
  const loaded = {};
  const transports = [];
  const device = {
    rtpCapabilities: {},
    async load(options) {
      loaded.options = options;
    },
    createSendTransport: (options) => (transports[0] = { ...transport(options.id), options }),
    createRecvTransport: (options) => (transports[1] = { ...transport(options.id), options }),
  };
  let changes = 0;
  const media = createMeetingMedia({
    command,
    createDevice: async () => device,
    onTracksChanged: () => changes++,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return { media, calls, loaded, transports, timers, stats: () => ({ maxRunning, changes }) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const state = (producers) => ({ selfId: "me", producers });
const remote = (id, kind = "camera", participantId = "bob") => ({ id, participantId, kind, paused: false, system: false });

test("start strips video orientation and creates send and receive transports", async () => {
  const context = setup();
  await context.media.start();
  assert.deepEqual(context.loaded.options.routerRtpCapabilities.headerExtensions, [{ uri: "keep" }]);
  assert.deepEqual(context.transports.map((value) => value.id), ["t1", "t2"]);
});

test("both transports use relay credentials and refresh without replacing tracks", async () => {
  const config = { iceServers: [{ urls: ["turns:turn.example.test:443?transport=tcp"], username: "session", credential: "temp" }],
    iceTransportPolicy: "relay", expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const context = setup({ iceConfig: config });
  await context.media.start();
  for (const value of context.transports) {
    assert.deepEqual(value.options.iceServers, config.iceServers);
    assert.equal(value.options.iceTransportPolicy, "relay");
  }
  const original = [...context.transports];
  await context.media.refreshIceConfig();
  assert.deepEqual(context.transports, original);
  for (const value of context.transports) assert.deepEqual(value.iceUpdate, { iceServers: config.iceServers });
  context.media.close();
});

test("reconcile consumes each remote producer once, serially, and exposes tracks", async () => {
  const context = setup();
  await context.media.start();
  const current = state({ p1: remote("p1"), p2: remote("p2", "audio"), own: remote("own", "audio", "me") });
  context.media.reconcile(current);
  context.media.reconcile(current);
  await settle();
  assert.equal(context.calls.filter((value) => value === "consume").length, 2, "own producer is not consumed; repeats are idempotent");
  assert.equal(context.stats().maxRunning, 1, "media commands never overlap");
  assert.equal(context.media.trackFor("p1").id, "track-c-p1");
  assert.ok(context.stats().changes >= 2);
});

test("reconcile closes consumers whose producer disappeared", async () => {
  const context = setup();
  await context.media.start();
  context.media.reconcile(state({ p1: remote("p1") }));
  await settle();
  const consumer = context.transports[1].consumers[0];
  context.media.reconcile(state({}));
  assert.equal(consumer.closed, true);
  assert.equal(context.media.trackFor("p1"), null);
});

test("a consumer whose track ends is forgotten and can be consumed again", async () => {
  const context = setup();
  await context.media.start();
  const current = state({ p1: remote("p1") });
  context.media.reconcile(current);
  await settle();
  context.transports[1].consumers[0].emit("trackended");
  assert.equal(context.media.trackFor("p1"), null);
  context.media.reconcile(current);
  await settle();
  assert.equal(context.calls.filter((value) => value === "consume").length, 2);
});

test("failed consumes retry with a growing delay and stop after the bound", async () => {
  const context = setup({ failConsume: () => true });
  await context.media.start();
  context.media.reconcile(state({ p1: remote("p1") }));
  await settle();
  for (let attempt = 1; attempt <= 6; attempt++) {
    const timer = context.timers.shift();
    if (!timer) break;
    assert.equal(timer.ms, 1000 * attempt);
    timer.fn();
    await settle();
  }
  assert.equal(context.calls.filter((value) => value === "consume").length, 6, "initial attempt plus five retries");
  assert.equal(context.timers.length, 0);
});

test("reconcile before start is remembered and applied after start", async () => {
  const context = setup();
  context.media.reconcile(state({ p1: remote("p1") }));
  await context.media.start();
  await settle();
  assert.equal(context.media.trackFor("p1")?.id, "track-c-p1");
});

test("publish, pause and unpublish drive the local producer and server", async () => {
  const context = setup();
  await context.media.start();
  const id = await context.media.publish({ id: "mic" }, "audio");
  assert.equal(id, "own-1");
  assert.equal(context.transports[0].stopTracks, false, "capture, not the producer, owns track lifetime");
  await context.media.setPaused(id, true);
  await context.media.unpublish(id);
  assert.deepEqual(context.calls.slice(-3), ["produce", "pauseProducer", "closeProducer"]);
  assert.equal(context.media.trackFor(id), null);
});

test("hidden camera pauses forwarding without replacing tracks or pausing audio", async () => {
  const context = setup();
  await context.media.start();
  context.media.reconcile(state({ video: remote("video"), voice: remote("voice", "audio") }));
  await settle();
  const track = context.media.trackFor("video");
  context.media.setVideoVisible("video", false);
  context.timers.at(-1).fn();
  await settle();
  assert.equal(context.transports[1].consumers.find(c => c.id === "c-video").paused, true);
  assert.equal(context.transports[1].consumers.find(c => c.id === "c-voice").paused, false);
  assert.equal(context.calls.at(-1), "pauseConsumer");
  context.media.setVideoVisible("video", true);
  await settle();
  assert.equal(context.media.trackFor("video"), track);
  assert.equal(context.calls.at(-1), "resumeConsumer");
  assert.equal(context.calls.filter(op => op === "consume").length, 2);
  context.media.close();
});
