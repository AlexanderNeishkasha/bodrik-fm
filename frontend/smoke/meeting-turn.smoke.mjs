import { expect, request, test } from "@playwright/test";
import { nextDriver } from "./meetingDriver.mjs";

/** Generate bounded audible fixture music without reading user media or invoking ffmpeg. */
function tone() {
  const rate = 8000;
  const samples = rate * 180;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 5000), 44 + i * 2);
  return bytes;
}

/** Create only an isolated local account/room and start its synthetic music. */
async function prepareRoom() {
  const baseURL = process.env.TURN_SMOKE_API_BASE;
  const url = new URL(baseURL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "3003") {
    throw new Error("TURN smoke must use the isolated localhost:3003 fixture");
  }
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: "http://localhost:3000" } });
  /** Assert fixture commands without printing returned tokens or credentials. */
  const post = async (path, options) => {
    const response = await api.post(path, { ...options, timeout: 15000 });
    expect(response.ok(), path).toBeTruthy();
    return response;
  };
  try {
    await post("/api/auth/login", { data: { login: "relay-check", password: "isolated-relay-password" } });
    const users = await (await api.get("/api/admin/users")).json();
    const user = users.find((value) => value.login === "relay-check");
    await post(`/api/admin/users/${user.id}/conference-access`, { data: { allowed: true } });
    await post("/api/studio/conference", { data: { enabled: true } });
    await post("/api/studio/conference/music-output", { data: { output: "conference" } });
    await post("/api/studio/upload", { multipart: { file: { name: "relay-tone.wav", mimeType: "audio/wav", buffer: tone() } } });
    const tracks = await (await api.get("/api/studio/tracks")).json();
    await post("/api/studio/play", { data: { id: tracks.at(-1).id } });
    const join = await post("/api/studio/conference/join", { data: {} });
    const host = new URL((await join.json()).join_url);
    return { host: host.pathname + host.hash, guest: host.pathname };
  } finally { await api.dispose(); }
}

/** Instrument browser-owned transports and credential expiry without recording secrets. */
async function participant(browser, name, path) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__relayPeers = [];
    window.__relayExpiry = [];
    window.__relaySockets = [];
    window.__relaySessions = [];
    window.__relayErrors = [];
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) {
        super(...args); window.__relayPeers.push(this);
        this.addEventListener("icecandidateerror", (event) => window.__relayErrors.push({ code: event.errorCode, text: event.errorText, url: event.url }));
      }
    };
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).includes("/ws/meeting/")) return;
        window.__relaySockets.push(this);
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data);
          if (message.type === "welcome") window.__relaySessions.push(message.stamp.sessionId);
          if (message.type === "result" && message.value?.iceServers) {
            window.__relayExpiry.push(message.value.expiresAt);
          }
        });
      }
    };
  });
  const page = await context.newPage();
  await page.goto(path);
  const driver = nextDriver(page);
  await driver.join(name, { video: true });
  return { context, page, driver };
}

/** Read selected candidates and media counters from live browser transports only. */
async function counters(page) {
  return page.evaluate(async () => {
    const reports = await Promise.all(window.__relayPeers.filter((peer) => peer.connectionState !== "closed").map((peer) => peer.getStats()));
    const rows = reports.flatMap((report) => [...report.values()]);
    const pairs = rows.filter((row) => row.type === "transport" && row.selectedCandidatePairId)
      .map((row) => rows.find((candidate) => candidate.id === row.selectedCandidatePairId));
    const selected = pairs.map((pair) => rows.find((row) => row.id === pair.localCandidateId));
    const inbound = rows.filter((row) => row.type === "inbound-rtp");
    return {
      peers: window.__relayPeers.map((peer) => ({ connection: peer.connectionState, ice: peer.iceConnectionState,
        gathering: peer.iceGatheringState, policy: peer.getConfiguration().iceTransportPolicy })),
      selected: selected.map((row) => ({ type: row.candidateType, url: row.url, relayProtocol: row.relayProtocol })),
      audio: inbound.filter((row) => row.kind === "audio").map((row) => ({ bytes: row.bytesReceived || 0, energy: row.totalAudioEnergy || 0 })),
      frames: inbound.filter((row) => row.kind === "video").reduce((sum, row) => sum + (row.framesDecoded || 0), 0),
      expires: [...window.__relayExpiry],
      sessions: new Set(window.__relaySessions).size,
      welcomes: window.__relaySessions.length,
      errors: [...window.__relayErrors],
    };
  });
}

test("forced TURN: audio, camera, music, credential refresh and reconnect", async ({ browser }) => {
  test.setTimeout(180000);
  const paths = await prepareRoom();
  const participants = [];
  try {
    participants.push(await participant(browser, "RelayHost", paths.host));
    participants.push(await participant(browser, "RelayGuest", paths.guest));
    for (const { page } of participants) {
      await expect.poll(async () => {
        const value = await counters(page);
        return { relay: value.selected.length === 2 && value.selected.every((row) => row.type === "relay"),
          audio: value.audio.filter((row) => row.bytes > 0).length >= 2,
          audible: value.audio.some((row) => row.energy > 0), video: value.frames > 0 };
      }, { message: "both transports select relay candidates and decode participant/music audio plus camera", timeout: 30000 })
        .toEqual({ relay: true, audio: true, audible: true, video: true });
    }
    const guest = participants[1];
    const original = await counters(guest.page);
    expect(original.sessions).toBe(1);
    await expect.poll(async () => Math.max(...(await counters(guest.page)).expires) - Math.min(...original.expires),
      { message: "short-lived credentials refresh during an active call", timeout: 65000 }).toBeGreaterThan(30);
    const beforeRecovery = await counters(guest.page);
    expect(beforeRecovery.sessions).toBe(1);
    await guest.page.evaluate(() => window.__relaySockets.at(-1).close());
    await expect.poll(async () => (await counters(guest.page)).welcomes).toBeGreaterThan(beforeRecovery.welcomes);
    await expect(guest.page.locator("main[data-meeting-status=admitted]")).toBeVisible();
    await expect.poll(async () => (await counters(guest.page)).frames,
      { message: "camera keeps decoding after signaling recovery", timeout: 20000 }).toBeGreaterThan(original.frames);
    const final = await counters(guest.page);
    expect(final.selected.every((row) => row.type === "relay")).toBe(true);
    expect(final.selected.every((row) => row.url?.startsWith("turns:"))).toBe(true);
    expect(final.sessions).toBe(1);
    expect(final.expires.length).toBeGreaterThan(beforeRecovery.expires.length);
    console.log(`TURN verified: ${final.selected.length} relay transports, ${final.audio.length} received audio streams, ${final.frames} decoded video frames.`);
  } catch (error) {
    for (const value of participants) console.log("Relay diagnostics:", JSON.stringify(await counters(value.page)));
    throw error;
  } finally {
    for (const value of participants.reverse()) {
      await value.driver.leave().catch(() => {});
      await value.context.close();
    }
  }
});
