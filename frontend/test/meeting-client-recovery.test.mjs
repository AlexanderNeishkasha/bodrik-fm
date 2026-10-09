import assert from "node:assert/strict";
import { test } from "node:test";

import { READMIT_DELAYS_MS, createMeetingClient } from "../features/meeting/client/meetingClient.mjs";
import { RECONNECT_DELAYS_MS } from "../features/meeting/client/session.mjs";

/** Fake meeting server: one WebSocket class whose instances answer admission and commands. */
function fakeServer({ resumeFails = false } = {}) {
  const server = { sockets: [], sessions: 0, commands: [], produced: [] };
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      this.listeners = {};
      server.sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatch("open", {});
      });
    }
    addEventListener(name, listener) {
      (this.listeners[name] ||= []).push(listener);
    }
    dispatch(name, event) {
      for (const listener of this.listeners[name] || []) listener(event);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatch("close", {});
    }
    reply(frame) {
      queueMicrotask(() => this.readyState === 1 && this.dispatch("message", { data: JSON.stringify(frame) }));
    }
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.type === "admit") {
        server.sessions += 1;
        this.stamp = { roomInstanceId: "r", sessionId: `s${server.sessions}`, admissionEpoch: 1 };
        this.reply({ type: "welcome", version: 1, stamp: this.stamp, recoveryToken: "rt", revision: 0, phase: "admitted", presenter: false });
        return;
      }
      if (frame.type === "resume") {
        if (resumeFails) this.reply({ type: "error", code: "expired" });
        else this.reply({ type: "welcome", version: 1, stamp: (this.stamp = { ...frame, sessionId: frame.sessionId }), recoveryToken: "rt2", revision: 0, phase: "admitted", presenter: false });
        return;
      }
      if (frame.type !== "command") return;
      const action = frame.action;
      const operation = action.operation?.operation;
      server.commands.push(operation || action.type);
      let value = {};
      if (action.type === "iceConfig") value = { iceServers: [], iceTransportPolicy: "all", expiresAt: null };
      if (action.type === "snapshot") value = { revision: 0, count: 1, peers: [{ stamp: frame.stamp, name: "Me", presenter: false }] };
      if (action.type === "producers") value = [];
      if (operation === "capabilities") value = { codecs: [], headerExtensions: [] };
      if (operation === "createTransport") value = { id: `t${server.commands.length}` };
      if (operation === "produce") {
        value = { producerId: `p${server.produced.length + 1}` };
        server.produced.push(action.operation.payload.kind);
      }
      this.reply({ type: "result", version: 1, id: frame.id, stamp: frame.stamp, ok: true, value });
    }
  }
  return { server, Socket };
}

/** Fake mediasoup device whose send transport drives the produce handshake. */
function fakeDevice(transportsOut) {
  const transport = (id) => {
    const listeners = {};
    const value = {
      id,
      closed: false,
      on: (name, listener) => (listeners[name] = listener),
      emit: (name, arg) => listeners[name]?.(arg),
      async updateIceServers() {},
      async produce({ track, appData }) {
        return new Promise((resolve, reject) => listeners.produce({ kind: track.kind, appData, rtpParameters: {} }, ({ id: producerId }) => resolve({
          id: producerId, track, paused: false, pause() { this.paused = true; }, resume() { this.paused = false; }, close() {},
        }), reject));
      },
      close() {
        this.closed = true;
      },
    };
    transportsOut.push(value);
    return value;
  };
  return async () => ({ rtpCapabilities: {}, async load() {}, createSendTransport: (o) => transport(o.id), createRecvTransport: (o) => transport(o.id) });
}

/** Fake capture devices producing live tracks. */
const mediaDevices = {
  async getUserMedia(constraints) {
    const track = { kind: constraints.audio ? "audio" : "video", readyState: "live", stop() { this.readyState = "ended"; }, addEventListener() {} };
    return { getAudioTracks: () => (constraints.audio ? [track] : []), getVideoTracks: () => (constraints.audio ? [] : [track]), getTracks: () => [track] };
  },
  async enumerateDevices() {
    return [];
  },
};

/** Manual timers: tests release delays explicitly. */
function manualTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    /** Fire every pending timer with this delay. */
    fire(ms) {
      for (const timer of timers.filter((value) => value.ms === ms)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    },
  };
}

const flush = async () => {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Build a joined client against the fake server. */
async function joined(options = {}) {
  const { server, Socket } = fakeServer(options);
  const timers = manualTimers();
  const transports = [];
  const client = createMeetingClient({
    slug: "room",
    location: { protocol: "https:", host: "x.test" },
    crypto: { getRandomValues: (bytes) => bytes.fill(7) },
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: 1, ticket: "t", roomSlug: "room" }) }),
    WebSocketImpl: Socket,
    createDevice: fakeDevice(transports),
    mediaDevices,
    storage: null,
    ...timers,
    random: options.random || (() => 1),
  });
  const joining = client.join({ name: "Me", video: false });
  await flush();
  await joining;
  return { client, server, timers, transports };
}

test("join admits, publishes the microphone and loads the room", async () => {
  const { client, server } = await joined();
  assert.equal(client.getState().status, "admitted");
  assert.deepEqual(server.produced, ["audio"]);
  assert.deepEqual(client.getState().participants.s1 && client.getState().participants.s1.name, "Me");
});

test("a failed resume readmits as a new session and keeps the microphone muted", async () => {
  const { client, server, timers } = await joined({ resumeFails: true });
  await client.setMicrophoneMuted(true);
  server.sockets.at(-1).close();
  await flush();
  for (const delay of RECONNECT_DELAYS_MS) {
    timers.fire(delay);
    await flush();
  }
  assert.equal(client.getState().status, "reconnecting");
  timers.fire(READMIT_DELAYS_MS[0]);
  await flush();
  const state = client.getState();
  assert.equal(state.status, "admitted");
  assert.equal(state.selfId, "s2");
  assert.deepEqual(server.produced, ["audio", "audio"], "microphone republished once");
  const own = Object.values(state.producers).filter((value) => value.participantId === "s2");
  assert.deepEqual(own.map((value) => [value.kind, value.paused]), [["audio", true]], "mute state survives readmission");
  assert.equal(server.sockets.filter((socket) => socket.readyState === 1).length, 1, "exactly one open socket");
});

test("a failed media transport readmits", async () => {
  const { client, server, timers, transports } = await joined();
  transports[0].emit("connectionstatechange", "failed");
  await flush();
  assert.equal(client.getState().status, "reconnecting");
  assert.ok(server.commands.includes("leave"), "old session left before readmission");
  timers.fire(READMIT_DELAYS_MS[0]);
  await flush();
  assert.equal(client.getState().status, "admitted");
  assert.equal(server.sessions, 2);
});

test("readmission is not repeated while one is in progress, and leave cancels it", async () => {
  const { client, server, timers, transports } = await joined();
  transports[0].emit("connectionstatechange", "failed");
  transports[1].emit("connectionstatechange", "failed");
  await flush();
  await client.leave();
  timers.fire(READMIT_DELAYS_MS[0]);
  await flush();
  assert.equal(server.sessions, 1, "no new session after leave");
});

test("explicit leave sends leave once and does not recover", async () => {
  const { client, server, timers } = await joined();
  await client.leave();
  for (const delay of [...RECONNECT_DELAYS_MS, ...READMIT_DELAYS_MS]) timers.fire(delay);
  await flush();
  assert.equal(server.commands.filter((value) => value === "leave").length, 1);
  assert.equal(server.sessions, 1);
  assert.equal(client.getState().status, "left");
});

for (const [action, status] of [["eject", "kicked"], ["ban", "banned"]]) {
  test(`${action} ends on the ${status} page without readmitting`, async () => {
    const { client, server, timers } = await joined({ resumeFails: true });
    const socket = server.sockets.at(-1);
    // The server sends the final peerAction frame, then closes the socket.
    socket.reply({ type: "event", version: 1, stamp: socket.stamp, revision: 1, kind: "peerAction", value: { action, message: "", from: socket.stamp } });
    await flush();
    socket.close();
    await flush();
    for (const delay of [...RECONNECT_DELAYS_MS, ...READMIT_DELAYS_MS]) {
      timers.fire(delay);
      await flush();
    }
    assert.equal(client.getState().status, status);
    assert.equal(server.sessions, 1, "no readmission");
  });
}

test("a replaced session ends on the replaced page without readmitting", async () => {
  const { client, server, timers } = await joined({ resumeFails: true });
  const socket = server.sockets.at(-1);
  socket.reply({ type: "event", version: 1, stamp: socket.stamp, revision: 1, kind: "sessionReplaced", value: {} });
  await flush();
  socket.close();
  await flush();
  for (const delay of [...RECONNECT_DELAYS_MS, ...READMIT_DELAYS_MS]) {
    timers.fire(delay);
    await flush();
  }
  assert.equal(client.getState().status, "replaced");
  assert.equal(server.sessions, 1, "no readmission");
});

test("manual rejoin choices preserve muted media before teardown", async () => {
  const { client } = await joined();
  await client.setMicrophoneMuted(true);
  assert.deepEqual(client.getRetryChoice(), { name: "Me", avatar: "", audio: false, video: false });
  await client.leave();
  assert.deepEqual(client.getRetryChoice(), { name: "Me", avatar: "", audio: false, video: false });
});

test("transport recovery applies jitter before fresh admission", async () => {
  const { client, server, timers, transports } = await joined({ random: () => 0 });
  transports[0].emit("connectionstatechange", "failed");
  await flush();
  timers.fire(READMIT_DELAYS_MS[0]);
  await flush();
  assert.equal(server.sessions, 1, "fixed maximum delay was not scheduled");
  timers.fire(READMIT_DELAYS_MS[0] / 2);
  await flush();
  assert.equal(server.sessions, 2, "fresh admission follows the sampled delay");
  await client.leave();
});
