import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/romforge",
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  outputDir: "/tmp/romforge-status-browser",
  use: {
    baseURL: "http://127.0.0.1:8081",
    serviceWorkers: "block",
    reducedMotion: "reduce",
    hasTouch: true,
    actionTimeout: 15000,
    screenshot: "only-on-failure",
  },
});
