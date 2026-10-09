"use client";

import MeetingApp from "./MeetingApp";

/** Isolate meeting browser state behind the page's explicit client boundary. */
export default function MeetingClientBoundary() {
  return <MeetingApp />;
}
