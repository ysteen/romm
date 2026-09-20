import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/azahar",
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 15000 },
  outputDir:
    process.env.AZAHAR_TEST_OUTPUT ?? "/tmp/romm-azahar-browser-results",
  use: {
    baseURL: "http://127.0.0.1:8081",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
  },
});
