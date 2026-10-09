"use client";

import BrandedStatusPage from "./components/BrandedStatusPage";
import { ui } from "./lang/ru";

/** Render the themed 404 for missing pages or closed meeting invitations. */
export default function NotFound({ meeting = false } = {}) {
  return <BrandedStatusPage eyebrow="404" title={meeting ? ui.meetingPages.unavailableTitle : "Страница не найдена"}
    description={meeting ? ui.meetingPages.unavailableMessage : "Такой страницы нет или она была перемещена."}
    actions={[{ label: meeting ? ui.meetingPages.home : "На главную", href: "/" }, ...(!meeting ? [{ label: "В студию", href: "/studio" }] : [])]} />;
}
