const HLS_EXTS = new Set([
  "mp3",
  "m4a",
  "mp4",
  "aac",
  "flac",
  "wav",
  "ogg",
  "opus",
  "webm",
]);

const HLS_CACHE_VERSION = "ts-v1";

/** Stable native-HLS capability per element; weak keys do not retain retired players. */
const nativeHlsSupport = new WeakMap();

/** Return whether a media filename can use the generated HLS fallback. */
export function isHlsEligible(filename) {
  if (!filename) return false;
  const parts = filename.split(".");
  if (parts.length < 2) return false;
  return HLS_EXTS.has(parts.pop().toLowerCase());
}

/** Build the original-file media URL. */
export function getDirectUrl(base, filename) {
  return `${base}/media/${encodeURIComponent(filename)}`;
}

/** Build the versioned generated-HLS playlist URL. */
export function getHlsUrl(base, filename) {
  return `${base}/media/hls/${encodeURIComponent(filename)}/index.m3u8?v=${HLS_CACHE_VERSION}`;
}

/** Probe native HLS once per element, avoiding repeated unsupported-format warnings. */
export function canPlayHlsNatively(audio) {
  if (!audio?.canPlayType) return false;
  if (!nativeHlsSupport.has(audio)) {
    nativeHlsSupport.set(audio, Boolean(audio.canPlayType("application/vnd.apple.mpegurl")));
  }
  return nativeHlsSupport.get(audio);
}

/** Load hls.js only when a non-native browser requests an eligible track. */
async function loadHlsModule() {
  const hlsModule = await import("hls.js");
  return hlsModule.default;
}

/** Advance the attachment identity used to reject obsolete async imports. */
function nextAttachment(hlsRef) {
  hlsRef.__meetingFmAttachment = (hlsRef.__meetingFmAttachment ?? 0) + 1;
  return hlsRef.__meetingFmAttachment;
}

/** Destroy only the currently attached hls.js instance. */
function destroyCurrentHls(hlsRef) {
  if (!hlsRef?.current) return;
  hlsRef.current.destroy();
  hlsRef.current = null;
}

/** Invalidate pending attachment work and destroy the active hls.js instance. */
export function destroyHls(hlsRef) {
  if (!hlsRef) return;
  nextAttachment(hlsRef);
  hlsRef.__meetingFmPending = null;
  destroyCurrentHls(hlsRef);
}

/** Assign the original media source as the safe fallback. */
function attachDirect(audio, directUrl) {
  if (audio.src !== directUrl) {
    audio.src = directUrl;
    audio.load();
  }
  return directUrl;
}

/** Bind one network-error fallback without affecting a newer attachment. */
function bindHlsErrorFallback(Hls, hls, audio, directUrl, hlsRef) {
  if (hls.__meetingFmBoundError) return;
  hls.__meetingFmBoundError = true;
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data?.type !== Hls.ErrorTypes.NETWORK_ERROR || hlsRef.current !== hls) return;
    destroyHls(hlsRef);
    attachDirect(audio, directUrl);
  });
}

/** Attach native HLS, lazy hls.js, or the original file while rejecting stale work. */
export async function attachMediaSource({
  audio,
  base,
  filename,
  hlsRef,
  loadHls = loadHlsModule,
}) {
  if (!audio || !filename || !hlsRef) {
    destroyHls(hlsRef);
    return null;
  }
  const directUrl = getDirectUrl(base, filename);
  if (!isHlsEligible(filename)) {
    destroyHls(hlsRef);
    return attachDirect(audio, directUrl);
  }

  const hlsUrl = getHlsUrl(base, filename);
  if (canPlayHlsNatively(audio)) {
    destroyHls(hlsRef);
    if (audio.src !== hlsUrl) {
      audio.src = hlsUrl;
      audio.load();
    }
    return hlsUrl;
  }
  if (
    hlsRef.current?.__meetingFmUrl === hlsUrl &&
    hlsRef.current?.__meetingFmMedia === audio
  ) {
    return hlsUrl;
  }
  if (
    hlsRef.__meetingFmPending?.url === hlsUrl &&
    hlsRef.__meetingFmPending?.audio === audio
  ) {
    return hlsRef.__meetingFmPending.promise;
  }

  const attachment = nextAttachment(hlsRef);
  const promise = (async () => {
    let Hls;
    try {
      Hls = await loadHls();
    } catch {
      if (hlsRef.__meetingFmAttachment !== attachment) return null;
      destroyCurrentHls(hlsRef);
      return attachDirect(audio, directUrl);
    }
    if (hlsRef.__meetingFmAttachment !== attachment) return null;
    if (!Hls.isSupported()) {
      destroyCurrentHls(hlsRef);
      return attachDirect(audio, directUrl);
    }

    destroyCurrentHls(hlsRef);
    try {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 90 * 1000 * 1000,
      });
      hls.__meetingFmUrl = hlsUrl;
      hls.__meetingFmMedia = audio;
      hlsRef.current = hls;
      bindHlsErrorFallback(Hls, hls, audio, directUrl, hlsRef);
      hls.loadSource(hlsUrl);
      hls.attachMedia(audio);
      return hlsUrl;
    } catch {
      destroyCurrentHls(hlsRef);
      return attachDirect(audio, directUrl);
    }
  })();
  hlsRef.__meetingFmPending = { url: hlsUrl, audio, promise };
  try {
    return await promise;
  } finally {
    if (hlsRef.__meetingFmPending?.promise === promise) hlsRef.__meetingFmPending = null;
  }
}
