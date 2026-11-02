import { t } from "../../../app/lang/index.js";

/** Resolve a status safely, with a connection failure as the unknown-state fallback. */
export function meetingStatusPage(status) {
  const text = t("meeting.meetingStatusCopy");
  const key = status === "connecting" ? "connectingPage" : status;
  return { text, page: Object.hasOwn(text, key) && typeof text[key] === "object" ? text[key] : text.failed };
}
