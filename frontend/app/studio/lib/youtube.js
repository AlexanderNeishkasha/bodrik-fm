import { t } from "../../lang/index.js";

/** Accept supported HTTPS YouTube URLs within the backend length limit. */
export function validateYoutubeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") {
      return false;
    }
    return [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
    ].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Return the Russian label for a YouTube job stage. */
export function youtubeStageLabel(stage) {
  if (stage === "downloading") return t("studio.youtubeStages.downloading");
  if (stage === "processing" || stage === "hls") return t("studio.youtubeStages.processing");
  if (stage === "queued") return t("studio.youtubeStages.queued");
  if (stage === "error") return t("studio.youtubeStages.error");
  return t("studio.youtubeStages.preparing");
}
