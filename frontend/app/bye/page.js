import BrandedStatusPage from "../components/BrandedStatusPage";
import { MEETING_STATUS_COPY } from "../../features/meeting/room/meetingStatusCopy.mjs";

/** Branded destination for old meeting exit links without a known room. */
export default function ByePage() {
  const text = MEETING_STATUS_COPY.ru;
  return <BrandedStatusPage title={text.left.title} description={text.left.description}
    actions={[{ label: text.home, href: "/" }]} />;
}
