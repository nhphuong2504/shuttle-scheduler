import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

/**
 * Configuration and safety guard for the integration suite.
 *
 * Every value is required. There is no skip and no default, for the same reason the
 * Playwright gate has an `assert-no-skips` step: a suite that quietly decides not to run
 * is worse than one that is absent, because it reports success while proving nothing.
 */

/**
 * The project refs the suite must never target.
 *
 * The Lovable Cloud project this repository is migrating away from, and the go-forward
 * production project. Both hold real staff accounts, and this suite creates and deletes
 * fixtures - so pointing it at either is a destructive mistake rather than a slow test.
 */
const PRODUCTION_PROJECT_REFS = ["hdmfxndanyrbxedgboev", "bwzemvaftzforfmaprif"];

/**
 * Load `integration/.env` into the process environment.
 *
 * `vitest.integration.config.ts` sets `envDir` to this directory so a root `VITE_` variable
 * never reaches the suite, but Vitest only routes `VITE_`-prefixed values into
 * `import.meta.env`. The names this suite requires - `SUPABASE_TEST_*` - are read from
 * `process.env`, so without this the file is inert and the suite reports itself as "not
 * configured" no matter how carefully it has been filled in.
 *
 * Values already present win, so a CI secret and an explicit shell export both take
 * precedence over the file, and this cannot silently override either.
 */
function loadIntegrationEnvFile(): void {
  let text: string;
  try {
    text = readFileSync(join(__dirname, ".env"), "utf8");
  } catch {
    // No file: fall back to the ambient environment, and let `required()` report what is missing.
    return;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    const rawValue = match[2];
    if (name === undefined || rawValue === undefined) continue;
    if (process.env[name] !== undefined) continue;
    process.env[name] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

loadIntegrationEnvFile();

/**
 * The project ref embedded in a Supabase URL.
 *
 * `https://abcdefghijklmnop.supabase.co` -> `abcdefghijklmnop`. Matches how supabase-js
 * derives its storage key, so the two agree about which project a client belongs to.
 */
export function projectRef(url: string): string {
  return new URL(url).hostname.split(".")[0] ?? "";
}

/**
 * Project refs that appear in the repository's own `.env`.
 *
 * Read as text rather than through `import.meta.env` on purpose: this check must see the
 * production values even though the suite deliberately does not load them. If `.env` is
 * absent - CI, or a fresh checkout - there is nothing to compare against and the hardcoded
 * ref above still applies.
 */
/**
 * Every project this repository is *configured to talk to*, read from the root environment
 * files - so a project the app can reach in any mode counts as protected.
 *
 * Reading `.env` alone was a mistake that survived one refactor too long: it made the
 * guard's protection depend on which file a project happened to live in. `env-split` moved
 * production out of `.env` and put staging in, and the guard silently changed from
 * "staging is allowed" to "staging is forbidden" without anyone editing it. The invariant
 * should not be able to change that way - so read all of them.
 *
 * `integration/.env` is deliberately NOT read: that is the suite's own declared target, and
 * folding it in would forbid the very project the suite is meant to run against.
 */
const REPOSITORY_ENV_FILES = [".env", ".env.local", ".env.development", ".env.production"];

function repositoryEnvRefs(): string[] {
  const refs: string[] = [];
  for (const file of REPOSITORY_ENV_FILES) {
    let text: string;
    try {
      text = readFileSync(join(__dirname, "..", file), "utf8");
    } catch {
      continue;
    }
    for (const key of ["SUPABASE_URL", "VITE_SUPABASE_URL"]) {
      const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*([^\\s#]*)`, "m"));
      const value = match?.[1]?.replace(/^["']|["']$/g, "");
      // An empty assignment (as in `.env.example`) is a placeholder, not a project.
      if (!value || !/^https?:/.test(value)) continue;
      const ref = projectRef(value);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Integration suite is not configured: ${name} is missing.\n\n` +
        "This suite needs a Supabase project that is NOT production. Set:\n" +
        "  SUPABASE_TEST_URL                 https://<ref>.supabase.co\n" +
        "  SUPABASE_TEST_PUBLISHABLE_KEY     the publishable (anon) key\n" +
        "  SUPABASE_TEST_SERVICE_ROLE_KEY    the service-role key, for test fixtures only\n\n" +
        "The service-role key bypasses Row Level Security, so it is used exclusively to\n" +
        "create and delete the fixtures these tests own - never to assert authorization,\n" +
        "which would be meaningless. Never point this suite at production.",
    );
  }
  return value;
}

const url = required("SUPABASE_TEST_URL");
const publishableKey = required("SUPABASE_TEST_PUBLISHABLE_KEY");
const serviceRoleKey = required("SUPABASE_TEST_SERVICE_ROLE_KEY");

export const TEST_URL = url;
export const TEST_PROJECT_REF = projectRef(url);

/**
 * Refuses to run against anything that looks like production.
 *
 * Checked at module load, so the failure happens while collecting the suite rather than
 * partway through a test that has already written rows.
 */
export function assertNotProduction(ref: string): void {
  const forbidden = new Set([...PRODUCTION_PROJECT_REFS, ...repositoryEnvRefs()]);
  if (forbidden.has(ref)) {
    throw new Error(
      `Refusing to run: the integration suite is pointed at project "${ref}", which this ` +
        "repository is configured to use as a real backend (a root environment file names " +
        "it, or it is a known production project).\n" +
        "These tests write rows and flip the active-tournament pointer. Use a dedicated " +
        "test project and set SUPABASE_TEST_URL to it.",
    );
  }
}

assertNotProduction(TEST_PROJECT_REF);

/**
 * The application's own resolution rule, mirrored.
 *
 * `src/integrations/supabase/client.ts` reads `import.meta.env[...]` first and falls back
 * to `process.env[...]`. Both halves matter here: if the suite points at production through
 * either path, the tests below would assert against the wrong database. Returned rather
 * than asserted so `setup-guard.ts` can fail with a message that names the cause.
 */
export function applicationResolvedUrl(): string | undefined {
  return import.meta.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || undefined;
}

// --- Clients ------------------------------------------------------------------

export type AppClient = SupabaseClient<Database>;

/** Anonymous. Used to prove what an unauthenticated visitor cannot do. */
export function anonClient(): AppClient {
  return createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Service role. Bypasses RLS, so it is only for fixtures - never for assertions about access. */
export function serviceClient(): AppClient {
  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// --- Fixture identities -------------------------------------------------------

export type StaffRoleName = "admin" | "registrar" | "scorer" | "scheduler";

export interface TestIdentity {
  email: string;
  password: string;
  userId: string;
  role: StaffRoleName;
  client: AppClient;
}

/**
 * Creates a confirmed auth user with a staff role, and returns a signed-in client.
 *
 * Provisioning the identities rather than requiring operator-supplied credentials keeps the
 * suite self-contained: it needs only the three project values, and it exercises the same
 * path the application uses (`staff_roles` keyed by email, with `user_id` linked) rather
 * than a fixture that bypasses it.
 *
 * Order matters. `current_staff_role()` matches on `user_id = auth.uid()` OR on the email
 * claim, and `link_staff_role()` only backfills `user_id` when the row already exists - so
 * the staff row is inserted first, then the user, mirroring the documented recreation order.
 */
export async function createStaffIdentity(
  role: StaffRoleName,
  label: string,
): Promise<TestIdentity> {
  const admin = serviceClient();
  const tag = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `itest-${tag}@tournova.test`;
  const password = `itest-${tag}-${role}`;

  const { error: roleError } = await admin.from("staff_roles").insert({ email, role });
  if (roleError) throw new Error(`seeding staff_roles failed: ${roleError.message}`);

  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    // Confirmed so sign-in works regardless of the project's confirmation setting.
    email_confirm: true,
  });
  if (userError) throw new Error(`creating the auth user failed: ${userError.message}`);

  const client = createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in as ${role} failed: ${signInError.message}`);

  return { email, password, userId: created.user.id, role, client };
}

/**
 * A signed-in client for an identity this suite already provisioned.
 *
 * The fixture helpers sign in as part of creating an identity, which is the right default.
 * A test that deletes an identity and recreates it cannot use them for the second half: it
 * needs to sign in to an address it chose itself. Exposing the sign-in step keeps the
 * publishable key in one place instead of leaking it into the test that needs it.
 */
export async function signInClient(email: string, password: string): Promise<AppClient> {
  const client = createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signing in as ${email} failed: ${error.message}`);
  return client;
}

/** Removes an identity and its staff row. Safe to call for an identity that was never made. */
export async function destroyStaffIdentity(identity: TestIdentity | undefined): Promise<void> {
  if (!identity) return;
  const admin = serviceClient();
  // The user first: `staff_roles.user_id` may reference it, and the staff row is the
  // record the role is read from.
  await admin.auth.admin.deleteUser(identity.userId).catch(() => undefined);
  await admin.from("staff_roles").delete().eq("email", identity.email);
}

/**
 * A signed-in user with no `staff_roles` row.
 *
 * The shape matters: this is a real authenticated session that holds no role, which is the
 * only way to test that authentication alone grants nothing. A service-role client would
 * skip the distinction between "signed in" and "authorized" - the exact distinction the
 * authorization surface depends on.
 *
 * The email carries a random suffix, so a stale row from an interrupted run cannot collide
 * and turn this into a confusing sign-in failure.
 */
export async function createUnprivilegedIdentity(label: string): Promise<TestIdentity> {
  const admin = serviceClient();
  const tag = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `itest-${tag}@tournova.test`;
  const password = `itest-${tag}-none`;

  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw new Error(`creating an unprivileged user failed: ${userError.message}`);

  const client = createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in unprivileged failed: ${signInError.message}`);

  // `role` is not meaningful for this identity - it holds no staff row - but the shared
  // type requires a value. Cleanup deletes the auth user and matches no staff row.
  return { email, password, userId: created.user.id, role: "registrar", client };
}

/**
 * Asserts that an operation is refused.
 *
 * Written as a helper rather than repeated inline because the interesting assertion in an
 * authorization test is not that something threw, but that it threw *for an authorization
 * reason*. A missing table or a typo also throws, and would otherwise read as a pass.
 */
export async function expectRefused(
  run: () => PromiseLike<{ error: { message: string; code?: string } | null }>,
): Promise<{ message: string; code?: string }> {
  const { error } = await run();
  if (!error) {
    throw new Error(
      "Expected the operation to be refused, but it succeeded. A missing refusal is an " +
        "authorization hole: check the RLS policy and the function's has_staff_role guard.",
    );
  }
  return error;
}
