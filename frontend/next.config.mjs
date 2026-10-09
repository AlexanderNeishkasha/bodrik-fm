import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  allowedDevOrigins: ["pc.local"],
  reactCompiler: true,
  poweredByHeader: false,
  output: process.env.NODE_ENV === "production" ? "export" : undefined,
  // The frontend is self-contained, including when mounted as /app in Docker.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
};

if (process.env.NODE_ENV !== "production") {
  /** Mirrors nginx's retired download-page redirect in local development. */
  nextConfig.redirects = async () => [
    { source: "/download", destination: "/", permanent: true },
  ];
  nextConfig.rewrites = async () => [
    {
      source: "/room/:slug([A-Za-z0-9_-]{1,128})",
      destination: "/meeting",
    },
    {
      source:
        "/:slug((?!download$|privacy$|terms$|studio$|admin$|puppet_master$|api(?:/.*)?$|ws(?:/.*)?$|media(?:/.*)?$|desktop_releases(?:/.*)?$|_next(?:/.*)?$|404$|500$|favicon\\.ico$|apple-touch-icon\\.png$|android-chrome-192x192\\.png$|android-chrome-512x512\\.png$|site\\.webmanifest$).+)",
      destination: "/",
    },
  ];
}

export default nextConfig;
