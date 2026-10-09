/** Validate the authenticated ICE configuration without retaining unexpected server fields. */
export function iceOptions(value, now = Date.now()) {
  if (!value || !Array.isArray(value.iceServers) || value.iceServers.length > 8 ||
      !["all", "relay"].includes(value.iceTransportPolicy)) throw new Error("Invalid ICE configuration");
  if (!value.iceServers.length) {
    if (value.iceTransportPolicy !== "all" || value.expiresAt !== null) throw new Error("Invalid direct ICE configuration");
    return { iceServers: [], iceTransportPolicy: "all", expiresAt: null };
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt * 1000 <= now) throw new Error("Expired ICE configuration");
  const iceServers = value.iceServers.map((server) => {
    if (!server || !Array.isArray(server.urls) || !server.urls.length || server.urls.length > 8 ||
        server.urls.some((url) => typeof url !== "string" || !/^turns?:[^\s/@#?]+(?:\?transport=(?:tcp|udp))?$/.test(url)) ||
        typeof server.username !== "string" || !server.username || typeof server.credential !== "string" || !server.credential) {
      throw new Error("Invalid TURN configuration");
    }
    return { urls: [...server.urls], username: server.username, credential: server.credential };
  });
  return { iceServers, iceTransportPolicy: value.iceTransportPolicy, expiresAt: value.expiresAt };
}

/** Own coalesced credential requests and one expiry-aware refresh timer per media session. */
export function createIceConfiguration({ command, apply, onFailure, setTimer = setTimeout, clearTimer = clearTimeout,
  now = Date.now, random = Math.random }) {
  let closed = false;
  let pending = null;
  let timer = null;
  let expiresAt = null;

  /** Retry transient refresh failures while existing credentials remain valid. */
  function failedRefresh() {
    if (closed) return;
    const remaining = expiresAt * 1000 - now();
    if (remaining <= 0) { onFailure?.(); return; }
    timer = setTimer(() => { timer = null; refresh().catch(failedRefresh); }, Math.min(remaining, 5000 + random() * 5000));
  }

  /** Fetch fresh authorized credentials and update retained transports without restarting media. */
  function refresh() {
    if (closed) return Promise.reject(new Error("Media closed"));
    if (pending) return pending;
    pending = (async () => {
      const options = iceOptions(await command({ type: "iceConfig" }), now());
      if (closed) throw new Error("Media closed");
      await apply(options);
      if (closed) throw new Error("Media closed");
      if (timer !== null) clearTimer(timer);
      timer = null;
      expiresAt = options.expiresAt;
      if (expiresAt !== null) {
        const delay = (expiresAt * 1000 - now()) * (0.8 + random() * 0.1);
        timer = setTimer(() => { timer = null; refresh().catch(failedRefresh); }, Math.max(1, Math.floor(delay)));
      }
      return { iceServers: options.iceServers, iceTransportPolicy: options.iceTransportPolicy };
    })().finally(() => { pending = null; });
    return pending;
  }

  return {
    refresh,
    /** Fence late responses and release the owned refresh timer on leave/readmission. */
    close() { closed = true; if (timer !== null) clearTimer(timer); timer = null; },
  };
}
