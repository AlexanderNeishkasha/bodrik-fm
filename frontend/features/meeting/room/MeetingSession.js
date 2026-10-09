"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import BrandedStatusPage from "../../../app/components/BrandedStatusPage";
import { meetingStatusPage } from "./meetingStatusCopy.mjs";
import { applyTheme } from "../../../app/lib/theme";
import { profileAvatarPath } from "../client/protocol.mjs";
import { useMeetingState } from "../client/useMeetingState";
import MeetingPrejoin from "./MeetingPrejoin";
import MeetingRoom from "./MeetingRoom";
import { createSessionStore } from "./meetingSessionStore.mjs";
import tokens from "../meetingTheme.module.css";
import styles from "./MeetingSession.module.css";

/** Password prompt for a protected room. */
function PasswordPrompt({ client, text }) {
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const [pending, setPending] = useState(false);
  /** Submit the password. */
  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setWrong(false);
    const accepted = await client.submitPassword(password).catch(() => false);
    if (!accepted) setWrong(true);
    setPending(false);
  }
  return <form className={styles.password} onSubmit={submit}>
    <input type="password" aria-label={text.passwordLabel} placeholder={text.passwordLabel} value={password} onChange={(event) => setPassword(event.target.value)} required />
    {wrong && <p role="alert">{text.wrongPassword}</p>}
    <button type="submit" disabled={pending}>{pending ? text.connecting : text.submit}</button>
  </form>;
}

/**
 * One meeting from prejoin to leave for a public room slug. Creates its client on
 * mount (client-only), leaves on unmount and on pagehide.
 */
export default function MeetingSession({ slug }) {
  const origin = useSyncExternalStore(subscribeNever, () => window.location.origin, () => "");
  const store = useMemo(() => (origin ? createSessionStore(slug, origin) : null), [slug, origin]);
  const session = useSyncExternalStore(store?.subscribe ?? subscribeNever, store?.getSnapshot ?? noSession, noSession);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const state = useMeetingState(session?.client ?? null);
  const theme = useSyncExternalStore(session?.theme.subscribe ?? subscribeNever, session?.theme.getSnapshot ?? emptyTheme, emptyTheme);
  useDocumentTheme(theme);
  const { text, page } = meetingStatusPage(state.status, state.language);

  if (!session) return null;

  /** Join with the prejoin choices. */
  async function join(choice) {
    setJoining(true);
    try {
      await session.client.join(choice);
      // Remember the uploaded avatar so the next join can reuse it.
      const state = session.client.getState();
      const avatar = profileAvatarPath(state.participants[state.selfId]?.avatar, window.location);
      if (avatar) {
        try {
          globalThis.localStorage?.setItem("meeting.avatar", avatar);
        } catch {
          // Blocked storage: nothing to remember.
        }
      }
    } catch {
      // The client status carries the failure.
    } finally {
      setJoining(false);
      setJoined(true);
    }
  }

  const status = state.status;
  if (!joined && (status === "idle" || status === "connecting")) {
    return <MeetingPrejoin client={session.client} slug={slug} busy={joining} onJoin={join} language={state.language} />;
  }
  if (["admitted", "reconnecting"].includes(status)) {
    return <MeetingRoom session={session} origin={session.origin} />;
  }
  /** Start a fresh session without returning to the prejoin form. */
  async function retry() {
    if (joining) return;
    const choice = session.client.getRetryChoice();
    setJoining(true);
    try {
      await store.restart(choice);
    } catch {
      // The new client publishes the actionable failure state.
    } finally {
      setJoining(false);
    }
  }
  const actions = [];
  if (page.action) actions.push({ label: joining ? text.connecting : text[page.action], onClick: retry, disabled: joining });
  actions.push({ label: text.home, href: "/" });
  return <BrandedStatusPage title={page.title} description={page.description} language={state.language} actions={actions}>
    {status === "password" && <PasswordPrompt key={session.client.session.ownerProof} client={session.client} text={text} />}
  </BrandedStatusPage>;
}

/** Subscription for values that never change. */
function subscribeNever() {
  return () => {};
}

/** Session before the store has created one. */
function noSession() {
  return null;
}

/** Snapshot getter before a session exists: no room theme yet. */
function emptyTheme() {
  return "";
}

/**
 * While the meeting is open, give <html> the room's player theme and the meeting
 * tokens, so every panel, dialog and popup uses the player's look; restore on unmount.
 */
function useDocumentTheme(theme) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-theme");
    root.classList.add(tokens.theme);
    return () => {
      root.classList.remove(tokens.theme);
      if (previous) root.setAttribute("data-theme", previous);
    };
  }, []);
  useEffect(() => {
    if (theme) applyTheme(theme, { persist: false });
  }, [theme]);
}
