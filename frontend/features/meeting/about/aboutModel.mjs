/** Normalize an About snapshot from the Next.js view. */
export function normalizeAboutSnapshot(value = {}) {
  return { version: typeof value.version === "string" ? value.version.slice(0, 64) : "" };
}

/** Public corresponding-source repository; release metadata identifies each exported revision. */
export const SOURCE_REPOSITORY_URL = "https://github.com/AlexanderNeishkasha/bodrik-fm";
