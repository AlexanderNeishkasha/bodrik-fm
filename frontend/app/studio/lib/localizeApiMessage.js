import { ui } from "../../lang/ru";

/** Stable backend error messages mapped to the Studio's Russian copy. */
const API_MESSAGE_MAP = {
  no: ui.messages.unauthorized,
  forbidden: ui.messages.forbidden,
  missing: ui.messages.notFound,
  "invalid credentials": ui.messages.invalidCredentials,
  "login exists": ui.messages.loginExists,
  "invalid login": ui.messages.invalidLogin,
  "too many attempts": ui.messages.tooManyAttempts,
  "password confirmation mismatch": ui.messages.passwordConfirmationMismatch,
  "password must be 4-128 chars": ui.messages.passwordLength,
  "cannot delete admin account": ui.messages.cannotDeleteAdminAccount,
  "invalid slug": ui.messages.invalidSlug,
  "slug exists": ui.messages.slugExists,
  "name exists": ui.messages.nameExists,
  playing: ui.messages.trackPlaying,
  "invalid upload": ui.messages.invalidUpload,
  "empty upload": ui.messages.emptyUpload,
  "upload too large": ui.messages.uploadTooLarge,
  "unsupported format": ui.messages.unsupportedFormat,
  "invalid filename": ui.messages.invalidFilename,
  "failed to save upload": ui.messages.uploadFailed,
  "no file": ui.messages.noFile,
  "invalid id": ui.messages.invalidId,
  "invalid name": ui.messages.invalidName,
  "invalid index": ui.messages.invalidIndex,
  "invalid section": ui.messages.invalidSection,
  "invalid order": ui.messages.invalidOrder,
  "play failed": ui.messages.actionFailed,
  "seek failed": ui.messages.actionFailed,
  "skip failed": ui.messages.actionFailed,
  "resume failed": ui.messages.actionFailed,
  "action failed": ui.messages.actionFailed,
  "internal error": ui.messages.somethingWentWrong,
  "runtime error": ui.messages.runtimeError,
  "theme is required": ui.messages.themeRequired,
  "invalid theme": ui.messages.invalidTheme,
  "invalid position": ui.messages.invalidPosition,
  "password reset failed": ui.messages.passwordResetFailed,
  "cannot delete yourself": ui.messages.cannotDeleteYourself,
  "token error": ui.messages.actionFailed,
  "registration failed": ui.messages.registrationFailed,
  "login failed": ui.messages.loginFailed,
  "upload failed": ui.messages.uploadFailed,
  "invalid youtube url": ui.messages.invalidYoutubeUrl,
  "youtube too long": ui.messages.youtubeTooLong,
  "youtube metadata failed": ui.messages.youtubeDownloadFailed,
  "youtube download failed": ui.messages.youtubeDownloadFailed,
  "download busy": ui.messages.downloadBusy,
  "rename failed": ui.messages.renameFailed,
  "delete failed": ui.messages.deleteFailed,
};

export function localizeApiMessage(rawMessage, fallback = ui.messages.actionFailed) {
  const source = String(rawMessage || "").trim();
  if (!source) {
    return fallback;
  }

  const normalized = source.toLowerCase();
  if (API_MESSAGE_MAP[normalized]) {
    return API_MESSAGE_MAP[normalized];
  }

  if (normalized.startsWith("failed:")) {
    return ui.messages.actionFailed;
  }
  if (normalized.endsWith(" failed")) {
    return ui.messages.actionFailed;
  }

  return source;
}
