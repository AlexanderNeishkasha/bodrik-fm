import { t } from "../../lang/index.js";

/** Stable backend error messages mapped to the Studio's Russian copy. */
const API_MESSAGE_MAP = {
  no: t("messages.unauthorized"),
  forbidden: t("messages.forbidden"),
  missing: t("messages.notFound"),
  "invalid credentials": t("messages.invalidCredentials"),
  "login exists": t("messages.loginExists"),
  "invalid login": t("messages.invalidLogin"),
  "too many attempts": t("messages.tooManyAttempts"),
  "password confirmation mismatch": t("messages.passwordConfirmationMismatch"),
  "password must be 4-128 chars": t("messages.passwordLength"),
  "cannot delete admin account": t("messages.cannotDeleteAdminAccount"),
  "invalid slug": t("messages.invalidSlug"),
  "slug exists": t("messages.slugExists"),
  "name exists": t("messages.nameExists"),
  playing: t("messages.trackPlaying"),
  "invalid upload": t("messages.invalidUpload"),
  "empty upload": t("messages.emptyUpload"),
  "upload too large": t("messages.uploadTooLarge"),
  "unsupported format": t("messages.unsupportedFormat"),
  "invalid filename": t("messages.invalidFilename"),
  "failed to save upload": t("messages.uploadFailed"),
  "no file": t("messages.noFile"),
  "invalid id": t("messages.invalidId"),
  "invalid name": t("messages.invalidName"),
  "invalid index": t("messages.invalidIndex"),
  "invalid section": t("messages.invalidSection"),
  "invalid order": t("messages.invalidOrder"),
  "play failed": t("messages.actionFailed"),
  "seek failed": t("messages.actionFailed"),
  "skip failed": t("messages.actionFailed"),
  "resume failed": t("messages.actionFailed"),
  "action failed": t("messages.actionFailed"),
  "internal error": t("messages.somethingWentWrong"),
  "runtime error": t("messages.runtimeError"),
  "theme is required": t("messages.themeRequired"),
  "invalid theme": t("messages.invalidTheme"),
  "invalid position": t("messages.invalidPosition"),
  "password reset failed": t("messages.passwordResetFailed"),
  "cannot delete yourself": t("messages.cannotDeleteYourself"),
  "token error": t("messages.actionFailed"),
  "registration failed": t("messages.registrationFailed"),
  "login failed": t("messages.loginFailed"),
  "upload failed": t("messages.uploadFailed"),
  "invalid youtube url": t("messages.invalidYoutubeUrl"),
  "youtube too long": t("messages.youtubeTooLong"),
  "youtube metadata failed": t("messages.youtubeDownloadFailed"),
  "youtube download failed": t("messages.youtubeDownloadFailed"),
  "download busy": t("messages.downloadBusy"),
  "rename failed": t("messages.renameFailed"),
  "delete failed": t("messages.deleteFailed"),
};

export function localizeApiMessage(rawMessage, fallback = t("messages.actionFailed")) {
  const source = String(rawMessage || "").trim();
  if (!source) {
    return fallback;
  }

  const normalized = source.toLowerCase();
  if (API_MESSAGE_MAP[normalized]) {
    return API_MESSAGE_MAP[normalized];
  }

  if (normalized.startsWith("failed:")) {
    return t("messages.actionFailed");
  }
  if (normalized.endsWith(" failed")) {
    return t("messages.actionFailed");
  }

  return source;
}
