"use client";

import BrandedStatusPage from "../components/BrandedStatusPage";

/** Render the static server-error destination using the shared site design. */
export default function Error500() {
  return <BrandedStatusPage eyebrow="500" title="Ошибка сервера"
    description="На сервере что-то пошло не так. Попробуйте позже."
    actions={[{ label: "На главную", href: "/" }, { label: "В студию", href: "/studio" }]} />;
}
