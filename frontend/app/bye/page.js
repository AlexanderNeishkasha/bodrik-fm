import BrandedStatusPage from "../components/BrandedStatusPage";
import { t } from "../lang/index.js";

/** Branded destination for old meeting exit links without a known room. */
export default function ByePage() {
  const text = t("meeting.meetingStatusCopy");
  return <BrandedStatusPage title={text.left.title} description={text.left.description}
    actions={[{ label: text.home, href: "/" }]} />;
}
