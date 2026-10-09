"use client";

import BrandedStatusPage from "./components/BrandedStatusPage";

/** Render the site error boundary with the shared branded destination. */
export default function Error() {
  return <BrandedStatusPage eyebrow="500" title="Что-то пошло не так"
    description="Попробуйте перезагрузить страницу или вернуться на главную."
    actions={[{ label: "На главную", href: "/" }, { label: "В студию", href: "/studio" }]} />;
}
