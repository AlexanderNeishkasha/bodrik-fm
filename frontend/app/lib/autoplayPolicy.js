export const AUTOPLAY_POLICY = {
  ALLOWED: "allowed",
  ALLOWED_MUTED: "allowed-muted",
  DISALLOWED: "disallowed",
  UNKNOWN: "unknown",
};

export const getAutoplayPolicy = (audio) => {
  if (typeof navigator === "undefined" || !audio) {
    return AUTOPLAY_POLICY.UNKNOWN;
  }
  if (typeof navigator.getAutoplayPolicy === "function") {
    const policy = navigator.getAutoplayPolicy(audio);
    if (
      policy === AUTOPLAY_POLICY.ALLOWED ||
      policy === AUTOPLAY_POLICY.ALLOWED_MUTED ||
      policy === AUTOPLAY_POLICY.DISALLOWED
    ) {
      return policy;
    }
  }
  return AUTOPLAY_POLICY.UNKNOWN;
};

export const probeAutoplayPermission = async (audio) => {
  if (!audio) {
    return null;
  }
  const playResult = audio.play();
  if (!playResult || typeof playResult.then !== "function") {
    return true;
  }
  try {
    await playResult;
    return true;
  } catch (error) {
    if (error?.name === "NotAllowedError") {
      return false;
    }
    return null;
  }
};
