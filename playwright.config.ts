import { defineConfig, devices } from "@playwright/test";

/**
 * Rendered-app validation.
 *
 * Vitest covers pure logic and, since P0, component rendering in jsdom. Neither
 * can see the things this config exists for: computed contrast in a real browser,
 * whether a focus ring is actually visible, and whether a control is reachable
 * from the keyboard. Those need a layout engine and a real cascade.
 *
 * The dev server is started by Playwright unless one is already listening, so
 * running the suite beside an open browser session reuses it instead of
 * fighting over the port.
 */
const PORT = process.env["PLAYWRIGHT_PORT"] ?? "8080";
const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Playwright cleans its outputDir on start; keep runner evidence in a sibling.
  outputDir: process.env["PLAYWRIGHT_OUTPUT_DIR"] ?? "./test-results/browser",
  globalSetup: "./e2e/global-setup.ts",
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
   * Bounded so a slow route cannot take the whole run down with it.
   *
   * The default worker count is derived from the machine, and the default test timeout is
   * 30s. Together those were the cause of a cascading failure: the four contrast sweeps
   * each visit all 12 routes, so under a busy dev server they would sit on every worker
   * for 30s at a time, and the tests queued behind them would then hit their own 30s limit
   * and fail for a reason that had nothing to do with what they assert. Two changes fix
   * that structurally rather than by hoping the machine is quiet: a worker count that is
   * stated rather than inferred (so a run is reproducible across machines, which matters
   * more here than squeezing out the last second), and a test timeout with realistic room
   * for normal rendering after globalSetup has compiled the heavy route graphs.
   */
  workers: process.env["CI"] ? 2 : 4,
  timeout: 60_000,
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
   *
   * It is the dev server on purpose. React's production build drops the hydration-mismatch
   * console error that `route-sweep.spec.ts` listens for, so running against a build would
   * make that check pass vacuously. globalSetup pays the heavy cold transforms before
   * parallel workers begin; the route sweep shares each route load across its probes.
   */
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
