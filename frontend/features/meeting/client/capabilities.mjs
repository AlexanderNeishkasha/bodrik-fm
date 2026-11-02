/** Mobile operating systems, including iPadOS reporting a desktop user agent. */
export function isMobileDevice(navigatorRef = globalThis.navigator) {
  return navigatorRef?.userAgentData?.mobile === true
    || /Android|iPhone|iPad|iPod/i.test(navigatorRef?.userAgent || "")
    || (navigatorRef?.platform === "MacIntel" && navigatorRef?.maxTouchPoints > 1);
}

/** Output routing requires both a sink-selection API and enumerated destinations. */
export function audioOutputSelectionAvailable(devices, MediaElement = globalThis.HTMLMediaElement) {
  return typeof MediaElement?.prototype?.setSinkId === "function" && devices.length > 0;
}

/** Derive a conservative Android Chromium route hint separately from output API support. */
export function audioRoutingCapabilities(devices, navigatorRef = globalThis.navigator, MediaElement = globalThis.HTMLMediaElement) {
  const agent = navigatorRef?.userAgentData;
  const android = agent?.platform ? agent.platform === "Android" : /Android/i.test(navigatorRef?.userAgent || "");
  const chromium = agent?.brands?.some((brand) => /Chromium|Google Chrome|Vivaldi|Microsoft Edge|Opera/i.test(brand.brand))
    || /(?:Chrome|Chromium)\/\d+/i.test(navigatorRef?.userAgent || "");
  const outputSelectionAvailable = audioOutputSelectionAvailable(devices, MediaElement)
    && (!(android && chromium) || devices.some((device) => device.value && device.value !== "default"));
  return { outputSelectionAvailable, coupledAudioRouting: Boolean(android && chromium && !outputSelectionAvailable) };
}

/** Screen sharing is desktop-only, even when a mobile browser exposes a stub. */
export function screenSharingAvailable(mediaDevices, navigatorRef = globalThis.navigator) {
  return !isMobileDevice(navigatorRef) && typeof mediaDevices?.getDisplayMedia === "function";
}
