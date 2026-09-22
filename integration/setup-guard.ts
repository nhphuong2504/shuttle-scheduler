/**
 * Runs before any test body in the integration suite.
 *
 * `vitest.integration.config.ts` redirects `envDir` so the repository's root environment
 * files are not loaded, and `integration/env.ts` refuses a protected project ref. This file
 * closes the remaining gap between those two controls: it checks the URL the *application*
 * will actually resolve, which is the value that would send production writes.
 *
 * The distinction matters because the guard in `env.ts` validates `SUPABASE_TEST_URL` -
 * the suite's own configuration - while the application reads
 * `import.meta.env.VITE_SUPABASE_URL` and can be pointed somewhere else entirely by a stray
 * `.env`, a shell export, or a change to the Vitest config. Asserting both is what makes
 * "these tests cannot touch production" a property of the setup rather than a hope.
 */
import { afterAll } from "vitest";

import {
  applicationResolvedUrl,
  assertNotProduction,
  projectRef,
  serviceClient,
  TEST_PROJECT_REF,
  TEST_URL,
} from "./env";

const resolved = applicationResolvedUrl();

if (!resolved) {
  throw new Error(
    "Integration suite is not configured: the application resolved no Supabase URL.\n" +
      `Expected ${TEST_URL} via SUPABASE_URL (or VITE_SUPABASE_URL in a loaded .env).\n` +
      "See integration/env.ts for the required variables.",
  );
}

const resolvedRef = projectRef(resolved);

// Independent of env.ts's check, and deliberately so: this is the same refusal applied to
// a different input, so a bug in one does not disable the other.
assertNotProduction(resolvedRef);

if (resolvedRef !== TEST_PROJECT_REF) {
  throw new Error(
    "The application and the integration suite disagree about which project to use.\n" +
      `  test project (SUPABASE_TEST_URL): ${TEST_PROJECT_REF}\n` +
      `  application resolves to:          ${resolvedRef}\n` +
      "The application reads import.meta.env first, so a loaded VITE_SUPABASE_URL can " +
      "override the test project. Assertions would then run against the wrong database.\n" +
      "Check integration/vitest config `envDir` and any VITE_SUPABASE_URL in the shell.",
  );
}

/**
 * Connectivity, checked once before the suite rather than as a side effect of whichever
 * test happens to run first - so a wrong key or an unreachable project is reported as a
 * configuration problem, not as a failing assertion about the schema.
 */
try {
  const { error } = await serviceClient()
    .from("tournaments")
    .select("id")
    .limit(1);
  if (error) throw new Error(error.message);
} catch (cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  throw new Error(
    `Cannot reach the integration project (${TEST_PROJECT_REF}): ${detail}\n` +
      "Confirm SUPABASE_TEST_URL, the publishable key and the service-role key belong to " +
      "the same project, and that `tournaments` exists - run the migrations first.",
  );
}

// Named so a leaked fixture is obvious in the output rather than showing up as a mystery
// project ref in a diff later.
afterAll(() => {
  // Fixture cleanup is owned by each spec file, which knows what it created. This only
  // reports the project, so a green run still states which database it just wrote to.
  // eslint-disable-next-line no-console
  console.log(`[integration] ran against project ${TEST_PROJECT_REF}`);
});
