import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/aram",
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  outputDir: process.env.ARAM_TEST_OUTPUT ?? "/tmp/romm-aram-browser-results",
  use: {
    baseURL: "http://127.0.0.1:8081",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
  },
});
