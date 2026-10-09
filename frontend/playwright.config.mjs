import { defineConfig } from "@playwright/test";

/** Meeting smoke test against the running local dev stack (`bun run docker:dev:up`). */
export default defineConfig({
  testDir: "./smoke",
  testMatch: "**/*.smoke.mjs",
  // This fixture uses a separate backend and coturn; ordinary smoke runs use direct ICE.
  testIgnore: process.env.TURN_SMOKE_API_BASE ? [] : ["**/meeting-turn.smoke.mjs"],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "./.smoke-results",
  use: {
    baseURL: process.env.SMOKE_BASE_URL || "https://pc.local:3443",
    ignoreHTTPSErrors: true,
    permissions: ["camera", "microphone"],
    locale: "ru-RU",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
        ...(process.env.TURN_SMOKE_ALLOW_TEST_CERTIFICATES === "1" ? ["--ignore-certificate-errors"] : [])],
    },
  },
});
