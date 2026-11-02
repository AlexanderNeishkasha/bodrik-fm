/**
 * One local meeting room per parallel Playwright worker, so concurrent smoke tests never
 * see each other's participants. Global setup provisions the accounts; workers pick theirs
 * by `TEST_PARALLEL_INDEX`.
 */
import { readFileSync } from "node:fs";

import { expect, request } from "@playwright/test";

import { devOrigins } from "../devOrigins.mjs";

/** Parallel workers and smoke rooms (default 2: more workers saturate local browsers and flake on the 10 s limit); `SMOKE_ROOM` forces one shared room. */
export const SMOKE_WORKERS = process.env.SMOKE_ROOM ? 1 : Math.max(1, Number(process.env.SMOKE_WORKERS) || 2);

/** Local-only credentials for the dev stack's smoke accounts; never used against production. */
const PASSWORD = "local-smoke-password";

/** Backend origin for setup API calls (the dev stack's direct port). */
const API_BASE = process.env.SMOKE_API_BASE || "http://localhost:3001";

/** Smoke account login for one worker slot. */
const accountLogin = (index) => `smoke-worker-${index + 1}`;

/** A cookie-keeping API client that passes the backend's CSRF origin check. */
const apiContext = () => request.newContext({
  baseURL: API_BASE,
  extraHTTPHeaders: { origin: `https://${devOrigins().host}` },
});

/** Admin credentials: SMOKE_ADMIN_LOGIN/PASSWORD, else the dev stack's root .env. */
function adminCredentials() {
  if (process.env.SMOKE_ADMIN_LOGIN && process.env.SMOKE_ADMIN_PASSWORD) {
    return { login: process.env.SMOKE_ADMIN_LOGIN, password: process.env.SMOKE_ADMIN_PASSWORD };
  }
  const text = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  const env = Object.fromEntries(text.split(/\r?\n/)
    .map((line) => /^([A-Z_]+)=(.*)$/.exec(line)).filter(Boolean).map((match) => [match[1], match[2]]));
  return { login: env.ADMIN_LOGIN, password: env.ADMIN_PASSWORD };
}

/** POST and fail setup with the endpoint name (never the response body, which may hold tokens). */
async function post(api, path, data) {
  const response = await api.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()}`).toBeTruthy();
  return response;
}

/**
 * Ensure every worker's account exists with the meeting allowed and enabled, music routed into
 * the meeting and the room hidden from the public directory. Idempotent; returns the rooms.
 */
export async function provisionSmokeRooms(count = SMOKE_WORKERS) {
  const admin = await apiContext();
  try {
    await post(admin, "/api/auth/login", adminCredentials());
    const known = new Set((await (await admin.get("/api/admin/users")).json()).map((user) => user.login));
    const rooms = [];
    for (let index = 0; index < count; index++) {
      const login = accountLogin(index);
      const user = await apiContext();
      try {
        if (known.has(login)) await post(user, "/api/auth/login", { login, password: PASSWORD });
        else await post(user, "/api/auth/register", { login, password: PASSWORD, confirm_password: PASSWORD });
        const me = await (await user.get("/api/auth/me")).json();
        const id = (await (await admin.get("/api/admin/users")).json()).find((row) => row.login === login).id;
        await post(admin, `/api/admin/users/${id}/conference-access`, { allowed: true });
        await post(user, "/api/studio/conference", { enabled: true });
        await post(user, "/api/studio/conference/music-output", { output: "conference" });
        await post(user, "/api/studio/room/listed", { listed: false });
        rooms.push(me.room_slug);
      } finally {
        await user.dispose();
      }
    }
    return rooms;
  } finally {
    await admin.dispose();
  }
}

/** This worker's slot; module scope in a worker process may read it before any test starts. */
const slot = () => Number(process.env.TEST_PARALLEL_INDEX || 0);

/** The meeting room owned by this worker's smoke account (or the `SMOKE_ROOM` override). */
export function smokeRoom() {
  if (process.env.SMOKE_ROOM) return process.env.SMOKE_ROOM;
  const rooms = JSON.parse(process.env.SMOKE_ROOMS || "[]");
  const room = rooms[slot()];
  if (!room) throw new Error("Smoke rooms are not provisioned; run through the Playwright config");
  return room;
}

/** Studio credentials owning this worker's room, for host links and Studio API calls. */
export function smokeAccount() {
  return { login: accountLogin(slot()), password: PASSWORD };
}
