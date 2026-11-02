"use client";

import { useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore } from "react";

import BrandedStatusPage from "../../../app/components/BrandedStatusPage";
import { meetingStatusPage } from "./meetingStatusCopy.mjs";
import { applyTheme } from "../../../app/lib/theme";
import { profileAvatarPath } from "../client/protocol.mjs";
import { useMeetingState } from "../client/useMeetingState";
import MeetingPrejoin from "./MeetingPrejoin";
import MeetingRoom from "./MeetingRoom";
import { createSessionStore } from "./meetingSessionStore.mjs";
import { rememberProfile } from "../client/profiles.mjs";
import { enterRoomHistory, watchRoomBack } from "./roomHistory.mjs";
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
  // "joining" or "restarting" while a session change is in flight; "idle" otherwise.
  const [phase, setPhase] = useState("idle");
  const [joined, setJoined] = useState(false);
  // The in-flight join; a Back pressed while it is still finishing (e.g. avatar upload) waits for it.
  const [joinTask, setJoinTask] = useState(null);
  const joining = phase !== "idle";
  const state = useMeetingState(session?.client ?? null);
  const theme = useSyncExternalStore(session?.theme.subscribe ?? subscribeNever, session?.theme.getSnapshot ?? emptyTheme, emptyTheme);
  useDocumentTheme(theme);
  const { text, page } = meetingStatusPage(state.status);
  const inRoom = ["admitted", "reconnecting"].includes(state.status);

  /** Leave this session for a fresh prejoin; device and personal preferences carry over. */
  async function restartToPrejoin() {
    if (!store || phase === "restarting") return;
    setPhase("restarting");
    setJoined(false);
    try {
      await store.restart();
    } catch {
      // The new client publishes the actionable failure state.
    } finally {
      setPhase("idle");
    }
  }

  // Joining adds a history entry, so Back or a swipe back returns to prejoin.
  useEffect(() => {
    if (inRoom) enterRoomHistory(window.history);
  }, [inRoom]);
  const onBack = useEffectEvent(() => {
    if (phase === "joining" && joinTask) joinTask.then(restartToPrejoin);
    else if (joined || inRoom) restartToPrejoin();
  });
  useEffect(() => watchRoomBack(window, onBack), []);

  if (!session) return null;

  /** Join with the prejoin choices; resolves once joining has settled. */
  function join(choice) {
    const task = joinSession(choice);
    setJoinTask(task);
    return task;
  }

  /** Join, then save the identity; failures surface through the client status. */
  async function joinSession(choice) {
    setPhase("joining");
    try {
      await session.client.join(choice);
      // Save this identity as a profile with the uploaded avatar so the next join can reuse it.
      const state = session.client.getState();
      const avatar = profileAvatarPath(state.participants[state.selfId]?.avatar, window.location);
      rememberProfile(globalThis.localStorage, window.location, { name: choice.name, avatar });
    } catch {
      // The client status carries the failure.
    } finally {
      setPhase("idle");
      setJoined(true);
    }
  }

  const status = state.status;
  if (!joined && (status === "idle" || status === "connecting")) {
    return <MeetingPrejoin client={session.client} slug={slug} busy={joining} onJoin={join} />;
  }
  if (["admitted", "reconnecting"].includes(status)) {
    return <MeetingRoom session={session} origin={session.origin} />;
  }
  // Manual retries return to prejoin; automatic network recovery stays inside the client.
  const actions = [];
  if (page.action) actions.push({ label: joining ? text.connecting : text[page.action], onClick: restartToPrejoin, disabled: joining });
  actions.push({ label: text.home, href: "/" });
  return <BrandedStatusPage title={page.title} description={page.description} actions={actions}>
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
