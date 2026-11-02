import { provisionSmokeRooms } from "./smokeRooms.mjs";

/** Provision one room per worker; workers inherit the room list through the environment. */
export default async function globalSetup() {
  if (process.env.SMOKE_ROOM) return;
  process.env.SMOKE_ROOMS = JSON.stringify(await provisionSmokeRooms());
}
