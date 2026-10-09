import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  createParticipantsSource,
  decodeParticipants,
} from "../features/meeting/participants/participantsModel.mjs";

/** Compile the actual JSX view for server-render assertions without opening a browser or meeting session. */
async function renderer() {
  const built = await build({
    stdin: {
      contents: 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import View from "./features/meeting/participants/ParticipantsPanel.js"; export const render = snapshot => renderToStaticMarkup(React.createElement(View, { source: { getSnapshot: () => snapshot, subscribe: () => () => {}, reload: () => Promise.resolve(), execute: () => Promise.resolve() } }));',
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    outdir: "out",
    loader: { ".js": "jsx", ".css": "empty" },
    external: ["react", "react/*", "react-dom", "react-dom/*", "next/image"],
    jsx: "automatic",
  });
  const evaluated = { exports: {} };
  vm.runInNewContext(built.outputFiles.find((file) => file.path.endsWith(".js")).text, {
    module: evaluated,
    exports: evaluated.exports,
    require: createRequire(import.meta.url),
  });
  return evaluated.exports;
}

/** Match the actual retained getRoomInfo peers JSON boundary, including private fields that must be discarded. */
function room(name = "Participant") {
  return {
    peers: JSON.stringify([
      [
        "peer-1",
        {
          peer_info: {
            peer_id: "peer-1",
            peer_name: name,
            peer_avatar: "/uploads/avatars/123e4567-e89b-12d3-a456-426614174000.png",
            peer_presenter: true,
            peer_audio: true,
            peer_video: false,
            peer_screen: false,
            peer_token: "never-expose",
            user_agent: "private-to-view",
            peer_uuid: "not-needed",
          },
          transports: { secret: "resource" },
          private: "not-needed",
        },
      ],
    ]),
  };
}

/** Own a deferred transport and replaceable admission identity, with no socket/media side effects. */
function fixture(timeout) {
  let session = {};
  const requests = [];
  const source = createParticipantsSource({
    getSession: () => session,
    getLanguage: () => "en",
    timeout,
    requestRoom: (signal) =>
      new Promise((resolve, reject) =>
        requests.push({ signal, resolve, reject }),
      ),
  });
  return {
    source,
    requests,
    replace: () => {
      session = {};
    },
    disconnect: () => {
      session = null;
    },
  };
}

test("participant view renders presenter actions, lobby and safe fallback identity", async () => {
  const { render } = await renderer();
  const html = render({
    hidden: [], volumes: {},
    peers: [{ id: "peer-1", name: "Participant", avatar: "", volume: 100, presenter: false, audio: true, video: false, screen: false, bot: false }],
    lobby: [{ id: "waiting-1", name: "Waiting", avatar: "" }],
    available: true,
    pending: false,
    pendingCommand: null,
    error: null,
    actionError: null,
    language: "en",
    selfId: "local",
    presenter: true,
    followMe: false,
  });
  assert.match(html, /Participants/);
  assert.match(html, /Waiting room/);
  // Per-participant and room actions live behind menus that are closed on first render.
  assert.match(html, /aria-label="Actions: Participant"/);
  assert.match(html, /aria-label="Room actions"/);
  assert.match(html, /Invite/);
  assert.doesNotMatch(html, /Public chat/, "no public-chat row in the participants list");
  assert.match(html, /aria-label="Microphone on"/);
  assert.doesNotMatch(html, /peer_token|transport/);
});

test("participant decoder retains detached immutable display scalars only", () => {
  const input = room();
  const peers = decodeParticipants(input);
  assert.equal(peers[0].presenter, true);
  assert.equal(peers[0].audio, true);
  assert.ok(Object.isFrozen(peers));
  assert.ok(Object.isFrozen(peers[0]));
  assert.equal(JSON.stringify(peers).includes("never-expose"), false);
  assert.deepEqual(
    Object.keys(peers[0]).sort(),
    [
      "id",
      "name",
      "avatar",
      "volume",
      "presenter",
      "audio",
      "video",
      "screen",
      "bot",
    ].sort(),
  );
  input.peers = "[]";
  assert.equal(peers.length, 1);
});

test("participant decoder accepts only the bundled Bodrik FM avatar for the music bot", () => {
  const music = {
    peers: JSON.stringify([
      [
        "bodrik-music",
        {
          peer_info: {
            peer_id: "bodrik-music",
            peer_name: "Бодрик FM",
            peer_avatar: "/images/bodrik-ava.png",
            peer_bot: true,
          },
        },
      ],
    ]),
  };

  assert.equal(
    decodeParticipants(music, { origin: "https://meet.example" })[0].avatar,
    "https://meet.example/images/bodrik-ava.png",
  );
  const untrusted = JSON.parse(music.peers);
  untrusted[0][1].peer_info.peer_bot = false;
  assert.equal(
    decodeParticipants({ peers: JSON.stringify(untrusted) }, { origin: "https://meet.example" })[0].avatar,
    "",
  );
});

for (const [name, change] of [
  ["missing peers", () => ({})],
  ["nonstring peers", () => ({ peers: [] })],
  ["invalid JSON", () => ({ peers: "{" })],
  ["object peers", () => ({ peers: "{}" })],
  ["entry shape", () => ({ peers: "[[]]" })],
  [
    "identity mismatch",
    () => ({
      peers: JSON.stringify([
        ["wrong", { peer_info: { peer_id: "peer-1", peer_name: "Name" } }],
      ]),
    }),
  ],
  [
    "duplicate identity",
    (input) => ({
      peers: JSON.stringify([
        ...JSON.parse(input.peers),
        ...JSON.parse(input.peers),
      ]),
    }),
  ],
  [
    "invalid role",
    (input) => ({
      peers: input.peers.replace('"peer_presenter":true', '"peer_presenter":1'),
    }),
  ],
  ["empty name", () => room("")],
  ["oversized name", () => room("x".repeat(257))],
  ["oversized JSON", () => ({ peers: "x".repeat(2 * 1024 * 1024 + 1) })],
]) {
  test(`participant decoder rejects ${name} without partial projection`, () =>
    assert.throws(() => decodeParticipants(change(room()))));
}

test("participant source issues no request during construction/subscription; explicit reload coalesces", async () => {
  const h = fixture();
  const unsubscribe = h.source.subscribe(() => {});
  assert.equal(h.requests.length, 0);
  const operation = h.source.reload();
  assert.equal(h.source.reload(), operation);
  await Promise.resolve();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(room());
  await operation;
  assert.equal(h.source.getSnapshot().peers.length, 1);
  assert.equal(h.source.getSnapshot().pending, false);
  const before = h.source.getSnapshot();
  h.source.refresh();
  assert.equal(h.source.getSnapshot(), before);
  unsubscribe();
  h.source.dispose();
});

test("participant source publishes bounded lobby and current capabilities", () => {
  let presenter = true;
  const source = createParticipantsSource({
    getSession: () => "session:1",
    getLanguage: () => "ru",
    getCapabilities: () => ({ selfId: "peer-1", presenter }),
    requestRoom: async () => room(),
  });
  assert.equal(source.replaceRoom(room()), true);
  assert.equal(source.replaceLobby([{ id: "waiting-1", name: "Waiting", avatar: "https://remote.invalid/a.png" }]), true);
  assert.equal(source.getSnapshot().selfId, "peer-1");
  assert.equal(source.getSnapshot().presenter, true);
  assert.equal(source.getSnapshot().lobby[0].avatar, "");
  presenter = false;
  source.refresh();
  assert.equal(source.getSnapshot().presenter, false);
  source.dispose();
});

test("participant source serializes validated commands and reports rejection", async () => {
  let release;
  const commands = [];
  const source = createParticipantsSource({
    getSession: () => "session:1",
    getLanguage: () => "en",
    requestRoom: async () => room(),
    execute: (command) => {
      commands.push(command);
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const operation = source.execute({ type: "role", targetId: "peer-1", presenter: false });
  assert.equal(source.getSnapshot().pendingCommand, "role:peer-1");
  await assert.rejects(source.execute({ type: "pin", targetId: "peer-1" }), /already pending/);
  release({ ok: true });
  await operation;
  assert.deepEqual(commands[0], { type: "role", targetId: "peer-1", presenter: false });
  assert.equal(source.getSnapshot().pendingCommand, null);
  await assert.rejects(source.execute({ type: "volume", targetId: "peer-1", value: 101 }), /Invalid volume/);
  source.dispose();
});

test("participant source validates invitation and room-wide moderation commands; Follow Me is gone", async () => {
  const commands = [];
  const source = createParticipantsSource({
    getSession: () => "session:1",
    getLanguage: () => "en",
    getCapabilities: () => ({ selfId: "peer-1", presenter: true }),
    requestRoom: async () => room(),
    execute: async (command) => { commands.push(command); },
  });
  await source.execute({ type: "invite" });
  await assert.rejects(source.execute({ type: "follow", enabled: true }));
  await source.execute({ type: "moderateAll", action: "eject" });
  assert.deepEqual(commands, [{ type: "invite" }, { type: "moderateAll", action: "eject" }]);
  await assert.rejects(source.execute({ type: "moderateAll", action: "unknown" }), /Invalid room moderation/);
  source.dispose();
});

test("participant source fences a pending command when admission changes", async () => {
  let session = "session:1";
  let release;
  const source = createParticipantsSource({
    getSession: () => session,
    getLanguage: () => "en",
    requestRoom: async () => room(),
    execute: () => new Promise((resolve) => { release = resolve; }),
  });
  const operation = source.execute({ type: "pin", targetId: "peer-1" });
  session = "session:2";
  source.refresh();
  release({});
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(source.getSnapshot().peers.length, 0);
  source.dispose();
});

for (const outcome of ["dispose", "replace", "disconnect"]) {
  test(`participant source rejects ${outcome} immediately even when transport ignores abort`, async () => {
    const h = fixture();
    const operation = h.source.reload();
    await Promise.resolve();
    const rejected = assert.rejects(operation, { name: "AbortError" });
    if (outcome === "dispose") h.source.dispose();
    if (outcome === "replace") h.replace();
    if (outcome === "disconnect") h.disconnect();
    h.source.refresh();
    await rejected;
    assert.equal(h.requests[0].signal.aborted, true);
    h.requests[0].resolve(room("Obsolete"));
    await Promise.resolve();
    assert.equal(h.source.getSnapshot().peers.length, 0);
    h.source.dispose();
  });
}

test("participant source accepts replacement room while obsolete request is still in flight", async () => {
  const h = fixture();
  const first = h.source.reload();
  await Promise.resolve();
  const rejected = assert.rejects(first, { name: "AbortError" });
  h.replace();
  const second = h.source.reload();
  await rejected;
  await Promise.resolve();
  h.requests[1].resolve(room("Current"));
  await second;
  h.requests[0].resolve(room("Obsolete"));
  await Promise.resolve();
  assert.equal(h.source.getSnapshot().peers[0].name, "Current");
  h.source.dispose();
});

for (const reason of ["transport", "malformed", "deadline"]) {
  test(`participant source reports ${reason} without retries or successful empty fallback`, async () => {
    const h = fixture(reason === "deadline" ? 1 : undefined);
    const operation = h.source.reload();
    await Promise.resolve();
    if (reason === "transport") h.requests[0].reject(new Error("offline"));
    if (reason === "malformed") h.requests[0].resolve({});
    await assert.rejects(operation);
    assert.equal(h.source.getSnapshot().error, "unavailable");
    assert.equal(h.source.getSnapshot().pending, false);
    assert.equal(h.requests.length, 1);
    h.source.dispose();
  });
}
