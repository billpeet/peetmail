import { defineConfig } from "@playwright/test";

// E2E tests drive the real Tauri app (debug build) over WebView2's DevTools port,
// against the fake Graph server. See tests/README.md.
export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // Each test starts its own app + fake server; WebView2 instances are heavy-ish. Three
  // fit a 4-CPU GitHub runner (public repos) as well as a dev machine.
  workers: 3,
  retries: 0,
  // On CI a broken environment (the app can't start) fails every test after a 30s wait:
  // stop early so the run ends in minutes and the results still get uploaded.
  maxFailures: process.env.CI ? 5 : 0,
  reporter: [["list"], ["html", { outputFolder: "test-results/e2e-report", open: "never" }]],
});
