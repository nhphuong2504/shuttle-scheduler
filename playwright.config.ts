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
  fullyParallel: true,
  // A stray `test.only` would silently shrink the gate in CI.
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
