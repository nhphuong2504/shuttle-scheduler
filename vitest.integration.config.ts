import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Integration suite: the real application against a real Supabase project.
 *
 * This is deliberately a separate config from `vitest.config.ts`, not an extra include.
 * The default suite is pure logic and component rendering, runs on every push, and needs
 * nothing but `npm install`. This one needs a live database, writes rows, and takes orders
 * of magnitude longer, so folding it into `npm test` would make the fast gate slow and
 * hide the fact that it has an utterly different failure mode.
 *
 * WHY A SEPARATE PROJECT IS MANDATORY
 *
 * `e2e/fixtures/app-mock.ts` makes the Playwright suite hermetic: it intercepts transport
 * and aborts anything it does not answer, so a gap in the fixture fails loudly instead of
 * reaching a real backend. That is a strong guarantee and it is also the reason the mocked
 * suite cannot validate a backend at all - it never talks to one. RLS policies, RPC
 * authorization, realtime publication membership and the write path are all invisible to it.
 *
 * So these tests talk to a real project, which means they must never talk to the production
 * one. Two independent controls enforce that:
 *
 *   1. `envDir` is pointed at `integration/`, which contains no `.env`. The repository's
 *      root `.env` points at production, and the application prefers `import.meta.env`
 *      over `process.env` - so without this, a test run would silently authenticate
 *      against production. This is the subtle failure the setting exists to prevent.
 *   2. `integration/setup-guard.ts` asserts, before any test body runs, that the URL the
 *      application will actually resolve is the configured test project and is not the
 *      production ref. If either control is misconfigured the run aborts rather than
 *      writing to production.
 *
 * Run with `npm run test:integration`. It exits non-zero with an explanatory message when
 * the test project is not configured - never a silent pass.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  // See (1) above. `integration/` has no .env, so no VITE_ variable is loaded from files.
  envDir: "integration",
  test: {
    environment: "node",
    include: ["integration/**/*.test.ts"],
    // These tests share one database, and the lifecycle test mutates tournament state.
    // Serial execution is the only correct choice: parallel files would race on the
    // single active tournament.
    fileParallelism: false,
    // Cold Supabase connections, several round trips per assertion.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    setupFiles: ["integration/setup-guard.ts"],
  },
});
