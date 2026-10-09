/** Image formats accepted by the existing verified chat upload endpoint. */
export const CHAT_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
/** Maximum document transfer size; the server enforces the same bound. */
export const CHAT_FILE_BYTES = 100 * 1024 * 1024;

/** Format attachment sizes using localized numbers and familiar units. */
export function attachmentSize(size, language = "ru") {
  if (!Number.isSafeInteger(size) || size < 0) return "";
  const index = size >= 1024 * 1024 ? 2 : size >= 1024 ? 1 : 0;
  const value = new Intl.NumberFormat(language === "en" ? "en-US" : "ru-RU", { maximumFractionDigits: index ? 1 : 0 }).format(size / (1024 ** index));
  return `${value} ${[language === "en" ? "B" : "Б", language === "en" ? "KB" : "КБ", language === "en" ? "MB" : "МБ"][index]}`;
}

/** Validate filenames and sizes before creating a preview or starting a transfer. */
export function validAttachment(file) {
  return Boolean(file) && typeof file.name === "string" && Boolean(file.name.trim()) && file.name.length <= 255 &&
    !/[\/:\u0000-\u001f\u007f]/.test(file.name) && Number.isSafeInteger(file.size) && file.size >= 1 &&
    file.size <= (CHAT_IMAGE_TYPES.includes(file.type) ? 5 * 1024 * 1024 : CHAT_FILE_BYTES);
}
