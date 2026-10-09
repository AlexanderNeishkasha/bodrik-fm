/** RU/EN labels for the camera effects (`client/processing.mjs` BACKGROUND_MODES). */
const EFFECT_LABELS = Object.freeze({
  ru: Object.freeze({ title: "Эффект", off: "Без эффекта", low: "Небольшое размытие", high: "Сильное размытие", unsupported: "Эффекты недоступны в этом браузере." }),
  en: Object.freeze({ title: "Effect", off: "No effect", low: "Light blur", high: "Strong blur", unsupported: "Effects are not available in this browser." }),
});

/** Effect labels for one language. */
export function effectLabels(language) {
  return EFFECT_LABELS[language === "en" ? "en" : "ru"];
}
