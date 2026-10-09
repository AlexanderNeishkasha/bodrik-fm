import { flushSync } from "react-dom";

import { createMeetingChat } from "../client/chat.mjs";
import { createMeetingClient } from "../client/meetingClient.mjs";
import { createMeetingFiles } from "../client/files.mjs";
import { createMeetingParticipants } from "../client/participants.mjs";
import { takeHostGrant } from "../client/protocol.mjs";
import { downloadBlob } from "../client/downloadBlob.mjs";
import { createMeetingNotifications } from "../client/notifications.mjs";
import { createMeetingSettings } from "../client/settings.mjs";
import { createRoomTheme } from "../client/theme.mjs";
import { flushAndSettle, withViewTransition } from "./cardMotion.mjs";
import { createSpeakerTest } from "./speakerTest.mjs";
import { createConfirmations } from "./confirmations.mjs";

/** Play one meeting event sound (assets ship with the frontend build). */
function playSound(name) {
  if (!/^[a-zA-Z]+$/.test(name)) return;
  new Audio(`/meeting-assets/sounds/${name}.wav`).play().catch(() => {});
}

/** Create the client and every feature source for one meeting. */
function createSession(slug, origin) {
  const client = createMeetingClient({ slug, hostGrant: takeHostGrant() });
  const files = createMeetingFiles({ client, save: downloadBlob });
  const chat = createMeetingChat({
    client,
    slug,
    files,
    uploadImage: (file, options) => client.uploadImage("chat", file, options),
  });
  const theme = createRoomTheme({ slug });
  // Share requests from settings reach the room view; wake-lock state is shared with settings.
  const shareListeners = new Set();
  const share = () => shareListeners.forEach((listener) => listener());
  const confirmations = createConfirmations();
  const participants = createMeetingParticipants({ client, layout: client.layout, chat, slug, origin, onShare: share,
    confirm: confirmations.ask, layoutTransition: (change) => withViewTransition(change, flushAndSettle(flushSync)) });
  const wake = { active: false };
  const speakerTest = createSpeakerTest({ volume: () => client.preferences.getSnapshot().masterVolume / 100 });
  const offTestVolume = client.preferences.subscribe(speakerTest.syncVolume);
  const settings = createMeetingSettings({
    client,
    speakerTest,
    onShare: share,
  });
  const notifications = createMeetingNotifications({ client, playSound });
  let left = false;
  return {
    client, chat, participants, theme, settings, notifications, origin, slug, wake, confirmations,
    /** Observe requests to open the share dialog. */
    subscribeShare(listener) {
      shareListeners.add(listener);
      return () => shareListeners.delete(listener);
    },
    /** Leave once and release every feature source; options pass to the client's leave. */
    leave(options) {
      if (left) return Promise.resolve();
      left = true;
      chat.dispose();
      participants.dispose();
      files.dispose();
      offTestVolume();
      speakerTest.stop();
      settings.dispose();
      notifications.dispose();
      theme.stop();
      return client.leave(options);
    },
  };
}

/**
 * External store owning one meeting session for a slug: created on first subscribe,
 * left when the last subscriber is gone. Release is deferred a tick so React Strict
 * Mode's unmount/remount in development keeps the same session.
 */
export function createSessionStore(slug, origin, { create = createSession, schedule = (fn) => setTimeout(fn, 0), target = globalThis.window } = {}) {
  let session = null;
  let subscribers = 0;
  const listeners = new Set();
  let restarting = false;
  let generation = 0;
  let release = null;
  const leave = () => session?.leave();
  /** Unload without explicit leave, preserving refresh takeover and cancelling pending restart. */
  const unload = () => { generation++; return session?.leave({ notify: false }); };
  return {
    getSnapshot: () => session,
    /** Replace the disposed client and join immediately with the previous choices. */
    async restart(choice) {
      if (restarting || subscribers === 0) return;
      restarting = true;
      const attempt = ++generation;
      const capturePreferences = session?.client.capture?.preferences;
      const personal = session?.client.preferences?.getSnapshot();
      try {
        await session?.leave();
        if (subscribers === 0 || attempt !== generation) return;
        session = create(slug, origin);
        if (capturePreferences) for (const [key, value] of Object.entries(capturePreferences)) session.client.capture.setPreference(key, value);
        if (personal) for (const key of ["language", "shortcuts", "masterVolume"]) session.client.preferences.set(key, personal[key]);
        listeners.forEach(listener => listener());
        await session.client.join(choice);
      } finally {
        restarting = false;
      }
    },
    /** Own the session while views observe the store. */
    subscribe(listener) {
      subscribers += 1;
      listeners.add(listener);
      release = null;
      if (!session) {
        session = create(slug, origin);
        target?.addEventListener("pagehide", unload);
        queueMicrotask(listener);
      }
      return () => {
        subscribers -= 1;
        listeners.delete(listener);
        const pending = {};
        release = pending;
        schedule(() => {
          if (release !== pending || subscribers > 0) return;
          target?.removeEventListener("pagehide", unload);
          leave();
        });
      };
    },
  };
}
