import { defineConfig } from "@playwright/test";

import { devOrigins } from "./devOrigins.mjs";
import { SMOKE_WORKERS } from "./smoke/smokeRooms.mjs";

const { meetingHost } = devOrigins();

/** Meeting smoke test against the running local dev stack (`bun run docker:dev:up`). */
export default defineConfig({
  testDir: "./smoke",
  testMatch: "**/*.smoke.mjs",
  // This fixture uses a separate backend and coturn; ordinary smoke runs use direct ICE.
  testIgnore: process.env.TURN_SMOKE_API_BASE ? [] : ["**/meeting-turn.smoke.mjs"],
  // A healthy smoke finishes in a few seconds; tight limits make a stale locator fail
  // fast instead of stalling the serial run for minutes.
  timeout: 10_000,
  expect: { timeout: 5_000 },
  // Each worker owns a provisioned room (smoke/smokeRooms.mjs), so workers never share participants.
  globalSetup: "./smoke/globalSetup.mjs",
  workers: SMOKE_WORKERS,
  reporter: [["list"]],
  outputDir: "./.smoke-results",
  use: {
    baseURL: process.env.SMOKE_BASE_URL || `https://${meetingHost}`,
    ignoreHTTPSErrors: true,
    permissions: ["camera", "microphone"],
    locale: "ru-RU",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
        ...(process.env.TURN_SMOKE_ALLOW_TEST_CERTIFICATES === "1" ? ["--ignore-certificate-errors"] : [])],
    },
  },
});
