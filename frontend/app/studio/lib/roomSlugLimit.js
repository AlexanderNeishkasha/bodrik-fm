export const ROOM_SLUG_MAX_LENGTH = 30;

export function limitRoomSlug(value) {
  return String(value ?? "").slice(0, ROOM_SLUG_MAX_LENGTH);
}
