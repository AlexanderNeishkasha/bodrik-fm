export const formatSeconds = (value) => {
  if (Number.isNaN(value)) {
    return "0:00";
  }
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  if (hours > 0) {
    const paddedMinutes = String(minutes).padStart(2, "0");
    return `${hours}:${paddedMinutes}:${seconds}`;
  }
  return `${minutes}:${seconds}`;
};

export const displayName = (filename) => filename.replace(/\.[^.]+$/, "");
