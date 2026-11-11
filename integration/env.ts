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
 * Every project this repository is *configured to talk to*, read from the root environment
 * files - so a project the app can reach in any mode counts as protected.
 *
 * Reading `.env` alone was a mistake that survived one refactor too long: it made the
 * guard's protection depend on which file a project happened to live in. `env-split` moved
 * production out of `.env` and put staging in, and the guard silently changed which projects
 * it covered without anyone editing it. The invariant should not be able to change that way,
 * so all of them are read.
 *
 * The consequence is deliberate and worth stating plainly, because it is not obvious and was
 * once misdescribed: **staging is now protected.** `.env` names the staging project, so the
 * suite refuses to target it. That is not a bug to work around - it is the guard saying the
 * suite needs a project of its own, because it writes rows and flips the active-tournament
 * pointer. Pointing `integration/.env` at any project named by a root env file will be
 * refused; `PRODUCTION_PROJECT_REFS` above covers the two that are not named there.
 *
 * `integration/.env` is deliberately NOT read. It is the suite's own declared target, so
 * folding it in would let the suite forbid itself no matter where it points - and the target
 * is meant to be an explicit choice, not a second source of protected refs.
 *
 * The files are read as text rather than through `import.meta.env`, because the suite sets
 * its own `envDir` and so never loads the root `VITE_` values - reading them this way is what
 * lets the check see a project the suite itself is not configured to reach.
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

/**
 * The platform role a fixture identity holds.
 *
 * Two values, mirroring `profiles.system_role`. There is no per-tournament role here on
 * purpose: access to a tournament is a row in `tournament_editors`, or ownership, and
 * both are fixtures of their own below rather than a property of the identity.
 */
export type PlatformRole = "admin" | "user";

export interface TestIdentity {
  email: string;
  password: string;
  /** The auth identity. `profiles.user_id` and `desk_activity.actor_id` point at this. */
  userId: string;
  /** The durable profile. Ownership, editor rows and requests point at this instead. */
  profileId: string;
  role: PlatformRole;
  client: AppClient;
}

function randomTag(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates an auth user with a platform role, and returns a signed-in client.
 *
 * Provisioning the identities rather than requiring operator-supplied credentials keeps the
 * suite self-contained: it needs only the three project values, and it exercises the same
 * path the application uses - a `profiles` row keyed by email with `user_id` linked - rather
 * than a fixture that bypasses it.
 *
 * Order matters, and it is the documented recovery order. The `profiles` row is written
 * first, carrying the role; the auth user is created second, and the `link_profile()`
 * trigger attaches the identity to the row that already exists. Creating the user first
 * would let the trigger insert an ordinary `user` profile, and the fixture would then have
 * to raise its own role with a privilege an ordinary sign-up does not have.
 */
export async function createIdentity(role: PlatformRole, label: string): Promise<TestIdentity> {
  const admin = serviceClient();
  const tag = randomTag(label);
  const email = `itest-${tag}@tournova.test`;
  const password = `itest-${tag}-${role}`;

  const { error: profileError } = await admin.from("profiles").insert({ email, system_role: role });
  if (profileError) throw new Error(`seeding profiles failed: ${profileError.message}`);


  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    // Confirmed so sign-in works regardless of the project's confirmation setting.
    email_confirm: true,
    // Synthetic adult fixture, never a real person's acknowledgement.
    user_metadata: { pilot_adult_confirmed: true, pilot_terms_version: "2026-11-11-pilot-draft" },
  });
  if (userError) throw new Error(`creating the auth user failed: ${userError.message}`);

  const client = await signInClient(email, password);
  const { data: profile, error: readError } = await admin
    .from("profiles")
    .select("id, user_id")
    .eq("email", email)
    .single();
  if (readError) throw new Error(`reading the profile back failed: ${readError.message}`);
  // The link is the whole point of the ordering above, so it is asserted here rather than
  // left to fail as a puzzling "not authorized" three tests later.
  if (profile.user_id !== created.user.id) {
    throw new Error(
      `the profile for ${email} was not linked to its auth identity; link_profile() did not run`,
    );
  }

  return { email, password, userId: created.user.id, profileId: profile.id, role, client };
}

/**
 * A signed-in user with the ordinary platform role and no tournament access.
 *
 * The shape matters: a real authenticated session that owns nothing and edits nothing,
 * which is the only way to test that authentication alone grants nothing. A service-role
 * client would skip the distinction between "signed in" and "authorized" - the exact
 * distinction the authorization surface depends on.
 */
export async function createUserIdentity(label: string): Promise<TestIdentity> {
  return createIdentity("user", label);
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

/** Removes an identity, its profile row and anything it owned. Safe when it was never made. */
export async function destroyIdentity(identity: TestIdentity | undefined): Promise<void> {
  if (!identity) return;
  const admin = serviceClient();
  // The profile row is deleted last and by id: the auth-user delete fires `unlink_profile`,
  // which only clears the link, and a re-created identity would re-link to a row this
  // teardown does not want around.
  await admin.auth.admin.deleteUser(identity.userId).catch(() => undefined);
  await admin.from("profiles").delete().eq("id", identity.profileId);
  await admin.from("tournaments").delete().eq("owner_profile_id", identity.profileId);
}

// --- Tournament fixtures ------------------------------------------------------

export interface DayFixture {
  date: string;
  startTime: string;
  endTime: string;
  courts: number[];
}

export interface OwnedTournamentOptions {
  name?: string;
  timezone?: string;
  /**
   * Playing days, written after creation. The tournament window is the span of their dates, so
   * they always lie inside it. Omitted gives one day in the distant past, so the first-match
   * gate is already open; `[]` leaves the tournament with a window and no playing days.
   */
  days?: DayFixture[];
  /**
   * Whether the tournament keeps its one Men's Singles event. A tournament is created
   * complete, so it always starts with one; `false` removes it again afterwards, which is the
   * only way left to reach the "not ready" registration state.
   */
  category?: boolean;
  /**
   * Moves the tournament's status with the service role. Setup, never an assertion - the
   * interesting transitions are driven through the RPCs, and a test that needs a tournament
   * already `in_progress` should not first have to satisfy the start gate.
   */
  status?: "upcoming" | "in_progress" | "completed";
}

/** Writes the whole day/court configuration on `identity`'s session. */
export async function saveDays(
  identity: TestIdentity,
  tournamentId: string,
  days: DayFixture[],
): Promise<void> {
  const { error } = await identity.client.rpc("save_tournament_days", {
    p_tournament_id: tournamentId,
    p_days: days.map((day) => ({
      date: day.date,
      start_time: day.startTime,
      end_time: day.endTime,
      courts: day.courts,
      breaks: [],
    })),
  } as never);
  if (error) throw new Error(`save_tournament_days failed: ${error.message}`);
}

/** Writes one open Men's Singles event on `identity`'s session. */
export async function saveCategory(identity: TestIdentity, tournamentId: string): Promise<void> {
  const { error } = await identity.client.rpc("save_tournament_categories", {
    p_tournament_id: tournamentId,
    p_categories: [
      {
        code: "MS",
        name: "Men's Singles",
        entry_type: "individual",
        gender: "men",
        sort_order: 1,
        active: true,
        max_entries: null,
      },
    ],
  } as never);
  if (error) throw new Error(`save_tournament_categories failed: ${error.message}`);
}

/** The event every fixture tournament is created with, because creation requires one. */
const FIXTURE_EVENT = {
  code: "MS",
  name: "Men's Singles",
  entry_type: "individual",
  gender: "men",
  sort_order: 1,
  active: true,
  max_entries: null,
};

/**
 * Creates an `upcoming` tournament owned by `identity`.
 *
 * Called on the identity's own client, so `owner_profile_id` is that profile and RLS applies
 * exactly as it does for the real creator. Creation is atomic - a window, a timezone and an
 * event go in together or nothing does - so a fixture is always complete; playing days are
 * added afterwards, inside the window, the way the Schedule page adds them.
 */
export async function createOwnedTournament(
  identity: TestIdentity,
  options: OwnedTournamentOptions = {},
): Promise<string> {
  const days =
    options.days ??
    // Far in the past, so the first-match gate (00:00 of the window's first date) is already
    // open and a lifecycle test is about the lifecycle rather than about the clock. A test
    // that cares about the clock passes its own dates.
    [{ date: "2020-01-04", startTime: "09:00", endTime: "18:00", courts: [1, 2] }];
  const dates = days.map((day) => day.date).sort();
  const startsOn = dates[0] ?? "2020-01-04";
  const endsOn = dates[dates.length - 1] ?? startsOn;

  const { data, error } = await identity.client.rpc("create_tournament", {
    p_payload: {
      name: options.name ?? `itest-${randomTag("tournament")}`,
      format: "two_round_placement",
      venue_name: "Integration Test Venue",
      venue_timezone: options.timezone ?? "America/Chicago",
      starts_on: startsOn,
      ends_on: endsOn,
      categories: [FIXTURE_EVENT],
    },
  } as never);
  if (error) throw new Error(`create_tournament failed: ${error.message}`);
  const tournamentId = data as unknown as string;

  if (days.length > 0) await saveDays(identity, tournamentId, days);
  if (options.category === false) {
    const cleared = await identity.client.rpc("save_tournament_categories", {
      p_tournament_id: tournamentId,
      p_categories: [],
    } as never);
    if (cleared.error) throw new Error(`clearing the event failed: ${cleared.error.message}`);
  }
  if (options.status) await forceStatus(tournamentId, options.status);

  return tournamentId;
}

/**
 * Moves a tournament's status with the service role.
 *
 * A fixture, not an assertion. It exists so a test about scoring an `in_progress`
 * tournament does not also have to walk the whole create/configure/start sequence, and it
 * is deliberately not used to test any transition - those go through the RPCs.
 */
export async function forceStatus(
  tournamentId: string,
  status: "upcoming" | "in_progress" | "completed",
): Promise<void> {
  const { error } = await serviceClient().from("tournaments").update({ status }).eq("id", tournamentId);
  if (error) throw new Error(`forcing status failed: ${error.message}`);
}

/**
 * Adds an editor row directly, which is what `add_tournament_editor` writes.
 *
 * The service role is used so a test can set up an editor without the owner's session. The
 * row is keyed by *profile*: membership is a fact about a person, and the auth id is only
 * what lets that person exercise it.
 */
export async function grantEditor(
  tournamentId: string,
  editor: TestIdentity,
  owner: TestIdentity,
): Promise<void> {
  const { error } = await serviceClient().from("tournament_editors").insert({
    tournament_id: tournamentId,
    profile_id: editor.profileId,
    added_by_profile_id: owner.profileId,
  });
  if (error) throw new Error(`granting editor access failed: ${error.message}`);
}

/** Removes tournaments by id with the service role, cascading to everything they own. */
export async function destroyTournaments(...tournamentIds: (string | undefined)[]): Promise<void> {
  const ids = tournamentIds.filter((id): id is string => !!id);
  if (ids.length === 0) return;
  await serviceClient().from("tournaments").delete().in("id", ids);
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
        "authorization hole: check the RLS policy and the function's can_edit_tournament guard.",
    );
  }
  return error;
}
