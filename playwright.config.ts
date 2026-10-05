import { defineConfig, devices } from "@playwright/test";

/**
 * Rendered-app validation.
 *
 * Vitest covers pure logic and component rendering in jsdom. Neither can see the things
 * this config exists for: whether a route hydrates cleanly, whether a redirect lands where
 * it should, and whether a control is reachable from the keyboard. Those need a browser.
 *
 * The dev server is started by Playwright unless one is already listening, so
 * running the suite beside an open browser session reuses it instead of
 * fighting over the port.
 */
const PORT = process.env["PLAYWRIGHT_PORT"] ?? "8080";
const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // A stray `test.only` would silently shrink the gate in CI.
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: [
    ["list"],
    /**
     * The machine-readable report `scripts/assert-no-skips.mjs` reads.
     *
     * Always written rather than opt-in, because the guard is worthless if it depends on
     * remembering to enable it. `test-results/` is git-ignored.
     */
    ["json", { outputFile: "test-results/e2e-report.json" }],
  ],
  /**
   * The worker count is stated rather than inferred, so a run is reproducible across
   * machines. `ubuntu-latest` has 4 vCPU and a Playwright worker drives a whole Chromium,
   * so two workers already saturate a CI runner; a local machine gets one more.
   */
  workers: process.env["CI"] ? 2 : 4,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Navigation gets its own budget so a slow first paint reports as a navigation
    // problem rather than as whichever assertion happened to be running.
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  /**
   * The transport is mocked by `e2e/fixtures/app-mock.ts`, which every spec receives
   * through the shared `page` fixture, so the credentials this server boots with are never
   * used for data. An unmocked Supabase request is aborted rather than passed through, so
   * a gap in the fixture fails loudly instead of quietly reading the hosted project.
   */
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
