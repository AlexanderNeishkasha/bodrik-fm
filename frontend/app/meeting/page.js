import { Suspense } from "react";

import MeetingClientBoundary from "../../features/meeting/MeetingClientBoundary";

/** Render the fixed static meeting entry without starting browser resources on the server. */
export default function MeetingPage() {
  return <Suspense fallback={null}><MeetingClientBoundary /></Suspense>;
}
