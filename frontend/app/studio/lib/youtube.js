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

export function youtubeStageLabel(stage) {
  if (stage === "downloading") {
    return "загрузка";
  }
  if (stage === "processing" || stage === "hls") {
    return "обработка";
  }
  if (stage === "queued") {
    return "в очереди";
  }
  if (stage === "error") {
    return "ошибка";
  }
  return "подготовка";
}
