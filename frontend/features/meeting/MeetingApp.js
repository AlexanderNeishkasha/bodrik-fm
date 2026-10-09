"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import BrandedStatusPage from "../../app/components/BrandedStatusPage";
import { storedMeetingLanguage } from "./client/preferences.mjs";
import MeetingSession from "./room/MeetingSession";
import { meetingStatusPage } from "./room/meetingStatusCopy.mjs";
import { INITIAL_MEETING_ENTRY, startMeetingEntry } from "./runtime/meetingEntryLifecycle.mjs";

/** Resolve the public slug with a cancellable request and explicit retry. */
function useMeetingAdmission(pathname) {
  const [admission, setAdmission] = useState(INITIAL_MEETING_ENTRY);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const lifecycle = startMeetingEntry({ pathname, publish: setAdmission });
    return () => lifecycle.dispose();
  }, [pathname, attempt]);
  /** Retry invitation lookup before any name or device choices have been made. */
  function retry() {
    setAdmission(INITIAL_MEETING_ENTRY);
    setAttempt(value => value + 1);
  }
  return { admission, retry };
}

/** Resolve the invitation, then run the meeting or show its branded status. */
export default function MeetingApp() {
  const pathname = typeof window === "undefined" ? "/meeting" : window.location.pathname;
  const language = useSyncExternalStore(subscribeLanguage, storedMeetingLanguage, () => "ru");
  const { admission, retry } = useMeetingAdmission(pathname);
  const retriable = ["network", "rate_limited"].includes(admission.code);
  const status = admission.phase === "loading" ? "connecting" : retriable ? "failed" : "unavailable";
  const { text, page } = meetingStatusPage(status, language);
  const actions = [...(retriable ? [{ label: text.retry, onClick: retry }] : []), { label: text.home, href: "/" }];
  return <div data-meeting-entry="next" data-meeting-phase={admission.phase}>
    {admission.phase === "prejoin" && admission.slug ? <MeetingSession slug={admission.slug} />
      : <BrandedStatusPage title={page.title} description={page.description} language={language} actions={actions} />}
  </div>;
}

/** Refresh entry-page language if another tab changes the saved preference. */
function subscribeLanguage(listener) {
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
