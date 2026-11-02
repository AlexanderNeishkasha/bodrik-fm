/** Derive local player and meeting hosts from the development environment. */
export function devOrigins(environment = process.env) {
  const host = environment.LOCAL_DEV_HOST?.trim() || "localhost";
  const meetingHost = host === "localhost" || /^\d+(?:\.\d+){3}$/.test(host)
    ? host
    : `meet.${host}`;
  return {
    host,
    meetingHost,
    allowedDevOrigins: [...new Set([host, meetingHost])],
  };
}
