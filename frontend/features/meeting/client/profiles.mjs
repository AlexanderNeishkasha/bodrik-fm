/**
 * Saved meeting identities ("profiles"): a name plus an already uploaded avatar path.
 * They live only in this browser's storage; the most recently used profile comes first.
 */
import { profileAvatarPath } from "./protocol.mjs";

/** localStorage key holding the JSON profile list. */
export const PROFILES_KEY = "meeting.profiles";
/** Legacy single-identity keys, migrated into the first profile once. */
const LEGACY_NAME_KEY = "meeting.name";
const LEGACY_AVATAR_KEY = "meeting.avatar";
/** Upper bound on remembered profiles; the least recently used drop off. */
export const MAX_PROFILES = 12;
/** Display-name limit shared with the prejoin input. */
const NAME_MAX = 32;

/** @typedef {{ name: string, avatar: string }} MeetingProfile */

/** One valid profile, or null: trimmed non-empty name, same-origin avatar path or "". */
function cleanProfile(value, location) {
  if (!value || typeof value.name !== "string") return null;
  const name = value.name.trim().slice(0, NAME_MAX);
  if (!name) return null;
  let avatar = "";
  try {
    avatar = profileAvatarPath(value.avatar, location);
  } catch {
    // No document location (e.g. tests or blocked access): keep the name without a picture.
  }
  return { name, avatar };
}

/** Valid, name-unique, bounded copy of a raw list (first occurrence wins). */
function cleanList(values, location) {
  const seen = new Set();
  const list = [];
  for (const value of Array.isArray(values) ? values : []) {
    const profile = cleanProfile(value, location);
    if (!profile || seen.has(profile.name)) continue;
    seen.add(profile.name);
    list.push(profile);
  }
  return list.slice(0, MAX_PROFILES);
}

/**
 * Read saved profiles; without a saved list, the legacy remembered name/avatar
 * becomes the only profile. Blocked or corrupt storage reads as an empty list.
 * @returns {MeetingProfile[]}
 */
export function readProfiles(storage, location) {
  try {
    const raw = storage?.getItem(PROFILES_KEY);
    if (raw != null) return cleanList(JSON.parse(raw), location);
    const legacy = cleanProfile({ name: storage?.getItem(LEGACY_NAME_KEY), avatar: storage?.getItem(LEGACY_AVATAR_KEY) }, location);
    return legacy ? [legacy] : [];
  } catch {
    return [];
  }
}

/** Persist the list and retire the legacy keys; blocked storage is ignored. */
function writeProfiles(storage, list) {
  try {
    storage?.setItem(PROFILES_KEY, JSON.stringify(list));
    storage?.removeItem(LEGACY_NAME_KEY);
    storage?.removeItem(LEGACY_AVATAR_KEY);
  } catch {
    // Private mode: nothing to remember.
  }
}

/**
 * Record a used identity: it moves to the front, replacing a same-name profile.
 * An empty avatar keeps that profile's previous picture (e.g. a failed upload).
 * @returns {MeetingProfile[]} the saved list
 */
export function rememberProfile(storage, location, value) {
  const list = readProfiles(storage, location);
  const profile = cleanProfile(value, location);
  if (!profile) return list;
  const previous = list.find((item) => item.name === profile.name);
  const next = cleanList([{ ...profile, avatar: profile.avatar || previous?.avatar || "" },
    ...list.filter((item) => item !== previous)], location);
  writeProfiles(storage, next);
  return next;
}

/**
 * Apply an in-meeting edit to the profile now in use: `previousName` is renamed and its
 * avatar set exactly (an empty avatar clears it). It moves to the front; a missing
 * profile is added.
 * @returns {MeetingProfile[]} the saved list
 */
export function replaceProfile(storage, location, previousName, value) {
  const list = readProfiles(storage, location);
  const profile = cleanProfile(value, location);
  if (!profile) return list;
  const next = cleanList([profile, ...list.filter((item) => item.name !== previousName && item.name !== profile.name)], location);
  writeProfiles(storage, next);
  return next;
}

/**
 * Remove one profile by name; the uploaded avatar file itself stays on the server.
 * @returns {MeetingProfile[]} the saved list
 */
export function forgetProfile(storage, location, name) {
  const next = readProfiles(storage, location).filter((item) => item.name !== name);
  writeProfiles(storage, next);
  return next;
}
