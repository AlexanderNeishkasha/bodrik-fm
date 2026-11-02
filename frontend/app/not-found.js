"use client";

import BrandedStatusPage from "./components/BrandedStatusPage";
import { t } from "./lang/index.js";

/** Render the themed 404 for missing pages or closed meeting invitations. */
export default function NotFound({ meeting = false } = {}) {
  return <BrandedStatusPage eyebrow="404" title={meeting ? t("meetingPages.unavailableTitle") : "Страница не найдена"}
    description={meeting ? t("meetingPages.unavailableMessage") : "Такой страницы нет или она была перемещена."}
    actions={[{ label: meeting ? t("meetingPages.home") : "На главную", href: "/" }, ...(!meeting ? [{ label: "В студию", href: "/studio" }] : [])]} />;
}
