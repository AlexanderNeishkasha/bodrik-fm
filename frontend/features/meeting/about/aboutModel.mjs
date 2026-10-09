/** Normalize an About snapshot from the Next.js view. */
export function normalizeAboutSnapshot(value = {}) {
  return {
    language: value.language === "en" ? "en" : "ru",
    version: typeof value.version === "string" ? value.version.slice(0, 64) : "",
  };
}

/** Public corresponding-source repository; release metadata identifies each exported revision. */
export const SOURCE_REPOSITORY_URL = "https://github.com/AlexanderNeishkasha/bodrik-fm";

/** Human-maintained About copy for the meeting view. */
export const ABOUT_COPY = {
  ru: {
    title: "О системе", close: "Закрыть", platform: "Платформа встречи",
    description: "Эта встреча работает на базе MiroTalk SFU — открытой платформы видеоконференций.",
    platformLink: "Подробнее о MiroTalk SFU", license: "Лицензия",
    licenseDescription: "Компонент встречи и материалы MiroTalk SFU сохраняют лицензию AGPL-3.0.",
    licenseLink: "Текст лицензии AGPL-3.0",
    sourceLink: "Исходный код Бодрик FM",
  },
  en: {
    title: "About the system", close: "Close", platform: "Meeting platform",
    description: "This meeting service is based on MiroTalk SFU, an open-source video conferencing platform.",
    platformLink: "Learn more about MiroTalk SFU", license: "License",
    licenseDescription: "The meeting component and MiroTalk SFU assets retain their AGPL-3.0 license.",
    licenseLink: "Read the AGPL-3.0 license",
    sourceLink: "Bodrik FM source code",
  },
};
