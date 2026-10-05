import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import {
  E2E_USER_ID,
  REFERENCE,
  TOURNAMENT_ID,
  deskFixture,
  type DeskMockPreset,
  type MockMembership,
  type MockSummaryArgs,
} from "./desk-mock";

/**
 * The hermetic application mock.
 *
 * Every Playwright spec runs against this. It exists so that the rendered suite has no
 * dependency on a Supabase project: no credentials, no network, no shared mutable state,
 * and no chance of a test writing to a real tournament.
 *
 * ## Why the whole suite, and not just the two specs that already mocked
 *
 * Before this, only two specs intercepted the network.
 * The others reached the hosted project. That was wrong for three separate reasons,
 * and each one alone would have justified the change:
 *
 *   1. A test run could read production data. Nothing was writing, but a suite whose
 *      result depends on what happened to be in the live database is not a test.
 *   2. Every accessibility sweep measured an *empty* tournament - the hosted project has
 *      no courts, teams or matches - so the app's real content had never been scanned.
 *   3. It needed credentials in CI, which is exactly the secret a CI job should not hold.
 *
 * ## How a session can exist without a server
 *
 * `useSession` derives sign-in from `supabase.auth.getSession()`, which reads
 * `localStorage` synchronously and makes **no network call**, and derives the platform
 * role from `supabase.rpc("current_system_role")`, which is an ordinary REST request this
 * file answers. So seeding one storage entry plus a handful of mocked RPCs produces a
 * fully signed-in session with no auth server involved. Tournament access is answered the
 * same way, by `tournament_access`, because it is a per-tournament question and not part
 * of the session.
 *
 * The storage key is not invented: supabase-js computes
 * `sb-${hostname.split(".")[0]}-auth-token` from the project URL, so it is derived here
 * the same way, from the same value the app itself reads.
 *
 * ## What this deliberately does not do
 *
 * It does not stub the application. The real components run against the real stylesheet
 * in a real browser; only the transport is replaced. That is what makes a measurement
 * here worth anything.
 */

/**
 * The platform role the mock session holds. `null` means signed out.
 *
 * Two values, mirroring `system_role`. The five tournament-scoped staff roles were
 * retired by the role redesign: what someone may do is now a per-tournament answer, and
 * this mock gives any signed-in session the fixture tournament's one (owner, therefore
 * `can_edit`). A spec that needs a viewer passes `access` below and overrides it.
 */
export type MockRole = "admin" | "user" | null;

/**
 * The per-tournament access answer, mirroring `tournament_access`'s jsonb.
 *
 * Declared here rather than imported from the application so the harness stays a pure
 * transport double: a type imported from `src/` would let a change to the app's shape
 * silently retype the fixture instead of failing it.
 */
export interface MockTournamentAccess {
  is_platform_admin: boolean;
  is_owner: boolean;
  is_editor: boolean;
  can_edit: boolean;
  can_manage_access: boolean;
}

export interface AppMockOptions {
  /** Which match dataset to serve. `layout` is the eight-court fit fixture. */
  preset?: DeskMockPreset;
  /** The platform role the session holds. `null` means signed out. */
  role?: MockRole;

  /**
   * Overrides the fixture tournament's `status`.
   *
   * Needed because the fixture is `in_progress` — the desk's own state — and the
   * lifecycle vocabulary has two other words in it. A spec about the label has to be
   * able to serve a tournament that has not started or has finished, and neither can be
   * reached by clicking.
   */
  status?: "upcoming" | "in_progress" | "completed";
  /**
   * Overrides the fixture tournament's `format`.
   *
   * Needed because one `schedule` route renders whichever of the two scheduling views the
   * stored format names, so the *format* is what a spec has to vary to reach the other one.
   * Neither is reachable by clicking: the fixture is a placement tournament and the app has
   * no format switcher.
   */
  format?: "two_round_placement" | "round_robin";

  /**
   * Overrides part of the per-tournament access answer.
   * A signed-in session owns the fixture, so it is an owner by default. `viewer` is the
   * state with nothing stored anywhere, and it is the one the gating has to hide controls
   * for — so it has to be expressible here, not inferred from the platform role.
   */
  access?: Partial<MockTournamentAccess>;

  /**
   * The tournament the caller's pointer names, or `null` for a caller who has none.
   *
   * The fixture's session always has a working tournament, which is what most specs want:
   * a bookmark resolves to a page. A caller *without* one is the other half of the
   * fallback's contract - it is the state a brand-new account is in - so it has to be
   * expressible here rather than inferred from an empty pointer elsewhere.
   */
  pointer?: string | null;

  /**
   * What `review_tournament_registrations` answers, in the RPC's row-per-entry shape.
   *
   * The reviewer's queue is a read the fixture has no opinion about: with no rows it is
   * simply empty, which is the honest answer for every spec that is not about the queue -
   * and the nav badge is then absent rather than wrong. A spec about the queue supplies
   * the rows it wants, one per requested entry, and the app folds them exactly as it folds
   * the real answer.
   */
  registrationQueue?: readonly MockRegistrationRow[];

  /**
   * What `tournament_registration_state` answers, as the database's own word.
   *
   * `null` is the un-migrated/absent answer, which reads as `not_offered` - the honest
   * default, and the reason the Register panel is not drawn in any spec that does not ask
   * for a window. A spec about the participant surface arrives with `"open"`, because the
   * whole point of that surface is the form the window opens.
   */
  registrationState?: string | null;

  /**
   * What `my_tournament_registration` answers, in its row-per-entry shape.
   *
   * The caller's own request, as the participant's panel reads it. Empty by default, which
   * is the state of somebody who has not asked to enter yet.
   */
  myRegistration?: readonly MockMyRegistrationRow[];
}

/**
 * One `my_tournament_registration` row.
 *
 * The participant's read is narrower than the reviewer's: it carries the caller's own
 * request and its entries and no identity columns, because the caller is the identity.
 */
export interface MockMyRegistrationRow {
  registration_id: string;
  status: string;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  entry_id: string | null;
  category_id: string | null;
  category_code: string | null;
  category_name: string | null;
  entry_type: string | null;
  partner_name: string | null;
  partner_email: string | null;
}

/**
 * One `review_tournament_registrations` row, in the wire shape the RPC returns.
 *
 * Declared rather than imported from the app, deliberately: the fixture is the *other* side
 * of the contract, and a spec that imported the app's own row type would be asserting that
 * the app agrees with itself. The nulls matter here - a pending request has no `decided_at`
 * and a request with no entries has null entry columns - so the shape keeps them.
 */
export interface MockRegistrationRow {
  registration_id: string;
  profile_id: string | null;
  email: string | null;
  status: string;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  entry_id: string | null;
  category_id: string | null;
  category_code: string | null;
  category_name: string | null;
  entry_type: string | null;
  partner_name: string | null;
  partner_email: string | null;
  player_id: string | null;
  partner_player_id: string | null;
}

/** The placeholder project CI uses. All requests to it are intercepted. */
export const PLACEHOLDER_SUPABASE_URL = "https://e2e-placeholder.supabase.co";

const EMAIL = "desk@example.test";

/**
 * The Supabase URL the app under test will actually use.
 *
 * Resolution order mirrors the app's own (`import.meta.env` first, then `process.env`),
 * with one addition: the harness reads `.env` directly, because the Playwright process
 * does not get Vite's env injection and a developer should not have to export variables
 * just to run the suite. Vite prioritises `process.env` over `.env` files, so both sides
 * agree on which value wins.
 */
function supabaseUrl(): string {
  const fromProcess = process.env["VITE_SUPABASE_URL"] ?? process.env["SUPABASE_URL"];
  if (fromProcess) return fromProcess;
  try {
    const env = readFileSync(join(import.meta.dirname, "..", "..", ".env"), "utf8");
    const match = env.match(/^\s*VITE_SUPABASE_URL\s*=\s*(.+)\s*$/m);
    if (match?.[1]) return match[1].replace(/^["']|["']$/g, "");
  } catch {
    // No `.env` in CI, which is the expected case there.
  }
  return PLACEHOLDER_SUPABASE_URL;
}

/**
 * The `localStorage` key supabase-js will look for, derived exactly as it does.
 *
 * See `defaultStorageKey` in `@supabase/supabase-js`: the first label of the project
 * hostname. Getting this wrong fails quietly - `getSession()` simply returns null and
 * every spec sees a signed-out page - so it is derived rather than hardcoded.
 */
export function authStorageKey(): string {
  const host = new URL(supabaseUrl()).hostname;
  return `sb-${host.split(".")[0]}-auth-token`;
}

/**
 * A syntactically complete Supabase session.
 *
 * `expires_at` is a year out on purpose. supabase-js refreshes a session it believes is
 * near expiry, which would be a real network call to an auth endpoint that does not
 * exist here; a far-future expiry means the refresh timer never fires during a test.
 */
export function syntheticSession(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    access_token: "e2e-synthetic-access-token",
    token_type: "bearer",
    expires_in: 31_536_000,
    expires_at: nowSeconds + 31_536_000,
    refresh_token: "e2e-synthetic-refresh-token",
    user: {
      id: E2E_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: EMAIL,
      email_confirmed_at: new Date(0).toISOString(),
      phone: "",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      identities: [],
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    },
  });
}

/** Marks a page that already has the mock installed, so repeated calls are harmless. */
const INSTALLED = new WeakSet<Page>();

/**
 * The filters a table read can express here.
 *
 * `eq` and `in` are everything this app's own reads use, and they are answered rather than
 * ignored. Ignoring them was invisible while every fixture row satisfied every read - and
 * then `useMyTournaments` asked which tournaments the caller *owns*, and a viewer's fixture
 * happily returned the owner's row. The ownership on the row, the membership rows and the
 * access summary are three views of one fact, so the filter has to be answered for them to
 * agree.
 *
 * An operator this does not model is reported through the same channel as an unmocked
 * request rather than silently dropped: a filter that is quietly not applied is a fixture
 * answering a different question from the one it was asked, which is exactly the failure
 * this whole file exists to prevent.
 */
function applyFilters(rows: unknown[], search: URLSearchParams, page: Page): unknown[] {
  let filtered = rows;
  for (const [column, expression] of search.entries()) {
    if (RESERVED_PARAMS.has(column)) continue;
    const [operator, ...rest] = expression.split(".");
    const operand = rest.join(".");
    if (operator === "eq") {
      filtered = filtered.filter((row) => valueOf(row, column) === operand);
    } else if (operator === "in") {
      const members = operand.replace(/^\(|\)$/g, "").split(",");
      filtered = filtered.filter((row) => members.includes(valueOf(row, column)));
    } else {
      ESCAPES.get(page)?.push(`unmodelled filter ${column}=${expression}`);
    }
  }
  return filtered;
}

/** PostgREST's own query parameters, which are not filters. */
const RESERVED_PARAMS = new Set(["select", "order", "limit", "offset", "columns", "on_conflict"]);

function valueOf(row: unknown, column: string): string {
  const value = (row as Record<string, unknown>)[column];
  return value == null ? "" : String(value);
}

/**
 * Supabase requests that escaped the mock, collected per page.
 *
 * Exposed so the fixture can fail a test rather than let an unmocked call fail obscurely
 * somewhere else. A request landing here means the app asked for something this fixture
 * does not model, which is a gap in the mock, not a bug in the app.
 */
const ESCAPES = new WeakMap<Page, string[]>();

export function mockEscapes(page: Page): readonly string[] {
  return ESCAPES.get(page) ?? [];
}

/**
 * Installs the mock on a page. Safe to call more than once, and safe to call again to
 * switch preset: Playwright resolves routes last-registered-first, so a later call wins.
 */
export async function installAppMock(page: Page, options: AppMockOptions = {}): Promise<void> {
  const {
    preset = "layout",
    role = null,
    status,
    format,
    access: accessOverride,
    pointer,
    registrationQueue = [],
    registrationState = null,
    myRegistration = [],
  } = options;

  if (!INSTALLED.has(page)) {
    INSTALLED.add(page);
    ESCAPES.set(page, []);

    /**
     * The app's clock is pinned to the fixture's reference instant.
     *
     * The two have to agree or the seeded times mean nothing: the mock builds every
     * `scheduled`/`started` from `REFERENCE`, and the app derives each court's state by
     * comparing those instants to its own `Date.now()`. Left on the real clock, the
     * derivation moves with the wall clock - which is exactly how these tests used to fail
     * between midnight and 00:16, when a fixture seeded to show an overrun could not produce
     * one. See `REFERENCE` in `desk-mock.ts`.
     *
     * `setFixedTime` rather than `install`: it fixes `Date` while leaving timers running, so
     * intervals, animation frames and `transitionend` still fire. Freezing the timers too
     * would stall the app rather than stabilise it.
     */
    await page.clock.setFixedTime(REFERENCE);

    /**
     * Realtime is a websocket, which `page.route` cannot see.
     *
     * The app subscribes to `postgres_changes` on mount (`ops-live`). Left alone it would
     * open a real socket to a real project, and in CI it would retry against a host that
     * does not resolve. An intercepted socket is simply never connected: the channel stays
     * in its initial state, which is what the server render already shows, so nothing
     * flickers and no hydration mismatch is introduced.
     */
    await page.routeWebSocket(/supabase/, (ws) => {
      // Deliberately inert. No `connectToServer`, so no upstream socket is opened.
      void ws;
    });

    /**
     * The safety net, registered first so the specific handlers below take precedence.
     *
     * Anything addressed to a Supabase host that the mock does not explicitly answer is
     * aborted and recorded. This is the enforcement of "no automated test touches the
     * hosted project": it is not a convention, it is a blocked connection.
     *
     * Only Supabase hosts are touched. Everything else - the dev server's own assets, the
     * Google Fonts stylesheet and font files - must pass through untouched, because
     * `openCell` measures text metrics and an unloaded web font silently invalidates both
     * the contrast threshold and any geometry comparison.
     */
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!/(^|\.)supabase\.(co|in)$/.test(url.hostname)) {
        await route.fallback();
        return;
      }
      ESCAPES.get(page)?.push(`${route.request().method()} ${url.pathname}`);
      await route.abort("blockedbyclient");
    });
  }

  // Re-seeded on every call, so switching role between calls takes effect without a
  // second page.
  await seedSession(page, role);

  /**
   * The per-tournament access answer, for the fixture tournament.
   *
   * A signed-in session owns it, which is what makes the edit controls render. A
   * signed-out one gets the all-false viewer answer - the same shape the database
   * returns - rather than an empty body, so the gating code path is exercised instead of
   * being short-circuited by a decode error.
   */
  const access: MockTournamentAccess =
    role === null
      ? {
          is_platform_admin: false,
          is_owner: false,
          is_editor: false,
          can_edit: false,
          can_manage_access: false,
        }
      : {
          is_platform_admin: role === "admin",
          is_owner: true,
          is_editor: false,
          // The owner can edit, so `can_edit` is true even for a plain `user`: the
          // question is per-tournament, and this session owns the tournament.
          can_edit: true,
          can_manage_access: true,
        };

  /**
   * The override is applied *after* the default, and never the other way round.
   *
   * A spec that asks for a viewer gets a viewer even if it also asked for an admin
   * session, because the two are different answers to different questions and combining
   * them permissively is how a gating test ends up asserting nothing.
   */
  if (accessOverride) Object.assign(access, accessOverride);

  /**
   * The same answer, told to the row store.
   *
   * `tournament_access` is what hides the controls; the rows are what the pages that do
   * not call the RPC read instead. `/setup` is the one that matters: it derives ownership
   * itself, from `tournaments.owner_profile_id` against the caller's own profile, and an
   * editor from the `tournament_editors` membership. Serving a viewer the session's own
   * owner id would leave "You own this" and Delete rendering beside hidden controls, and
   * the spec would be asserting a fixture that disagrees with itself.
   */
  const membership: MockMembership = access.is_owner
    ? "owner"
    : access.is_editor
      ? "editor"
      : "viewer";
  const fixture = deskFixture(preset, role ?? "user", status, membership, format);

  /**
   * REST, which is every table read and every RPC in this app.
   *
   * There are no route loaders and no server functions: every data hook is a client-side
   * `useQuery`, so interception here covers the entire data surface. Unknown tables
   * resolve to `[]` rather than 404, which is the honest answer for a table the surface
   * under test does not read and keeps the mock from failing closed on an unrelated one.
   */
  await page.route("**/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const target = url.pathname.split("/rest/v1/")[1] ?? "";

    const rpc = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    // The platform role. `null` is the signed-out answer, which reads as `user` in the
    // hook, so a signed-out page is never treated as privileged.
    if (target === "rpc/current_system_role") {
      await rpc(role);
      return;
    }
    // The caller's own working tournament. A signed-in session is pointed at the fixture; a
    // signed-out one has no pointer at all, which is what the database answers too - there
    // is no public default to fall back to any more. A spec that asks for `pointer: null`
    // gets the state a brand-new signed-in account is in.
    if (target === "rpc/current_tournament_id") {
      await rpc(pointer !== undefined ? pointer : role === null ? null : TOURNAMENT_ID);
      return;
    }
    if (target === "rpc/tournament_access") {
      await rpc(access);
      return;
    }
    /**
     * The working-tournament pointer, written.
     *
     * It is *this caller's own row* and nothing global moves, so there is nothing for the
     * mock to record: the fixture's read already answers with the pointer the spec asked
     * for. Answering the write explicitly is what makes a switch a successful act here
     * rather than an unmodelled request that happens to look like an empty table.
     */
    if (target === "rpc/set_current_tournament") {
      await rpc(null);
      return;
    }
    /**
     * The card read behind Explore and My Tournaments.
     *
     * The arguments arrive in the request's JSON body, because `supabase.rpc` issues a POST -
     * there is no query string to read here. `p_ids` is the interesting one: My Tournaments
     * asks for a set of ids in one request, and an *empty* set is a legitimate "nothing to
     * show" rather than "everything", which is a distinction the fixture has to keep.
     */
    if (target === "rpc/tournament_summary") {
      const args = (route.request().postDataJSON() ?? {}) as MockSummaryArgs;
      await rpc(fixture.tournamentSummaries(args));
      return;
    }
    /**
     * Who may edit the fixture tournament, projected the way the RPC projects it.
     *
     * It used to answer `[]` unconditionally, and that was not a neutral default: the
     * owner is *always* a row in this list, so an editor asking for it got an empty one,
     * and the page then said the list was not theirs to read. The answer is derived from
     * the same rows the rest of the fixture serves - the membership rows and the
     * tournament's own `owner_profile_id`, joined against `profiles` for the addresses -
     * rather than invented here, so the list cannot disagree with the access summary that
     * decides whether the page draws it at all.
     */
    if (target === "rpc/list_tournament_editors") {
      type ProfileRow = { id: string; email: string | null };
      type EditorRow = { profile_id: string; created_at: string };
      type TournamentRow = { owner_profile_id: string; created_at: string };
      const profiles = (fixture.tables["profiles"] ?? []) as ProfileRow[];
      const emailOf = (id: string | null) => profiles.find((p) => p.id === id)?.email ?? "";
      const tournament = ((fixture.tables["tournaments"] ?? []) as TournamentRow[])[0];
      const rows = ((fixture.tables["tournament_editors"] ?? []) as EditorRow[]).map((e) => ({
        profile_id: e.profile_id,
        email: emailOf(e.profile_id),
        is_owner: false,
        created_at: e.created_at,
      }));
      rows.push({
        profile_id: tournament.owner_profile_id,
        email: emailOf(tournament.owner_profile_id),
        is_owner: true,
        created_at: tournament.created_at,
      });
      // The RPC's own order: the owner first, then the editors, each group by address.
      rows.sort((a, b) => Number(b.is_owner) - Number(a.is_owner));
      await rpc(rows);
      return;
    }
    /**
     * The participant's two reads. Both default to the "nothing here" answer - an absent
     * window word and no request - so every spec that is not about registration sees the page
     * as it is for somebody who has not asked to enter.
     */
    if (target === "rpc/tournament_registration_state") {
      await rpc(registrationState);
      return;
    }
    if (target === "rpc/my_tournament_registration") {
      await rpc(myRegistration);
      return;
    }
    /**
     * The reviewer's queue. An empty answer by default, which is the honest one for every
     * spec that is not about the queue: the nav badge is then absent rather than wrong.
     */
    if (target === "rpc/review_tournament_registrations") {
      await rpc(registrationQueue);
      return;
    }
    if (target.startsWith("rpc/tournament_readiness")) {
      await rpc([]);
      return;
    }

    const table = target.split("?")[0] ?? "";
    const rows = fixture.tables[table] ?? [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(applyFilters(rows, url.searchParams, page)),
    });
  });

  /**
   * Auth endpoints, answered benignly.
   *
   * A seeded session with a far-future expiry should never reach these. They exist so that
   * an unexpected call fails in a controlled way rather than escaping to the network -
   * and `/auth/v1/user` is answered with the synthetic user, because that is the one call
   * that is legitimately correct to make.
   */
  await page.route("**/auth/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/user")) {
      const { user } = JSON.parse(syntheticSession()) as {
        user: { id: string; email: string };
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: user.id, email: user.email }),
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
}

/**
 * Seeds (or clears) the synthetic session before any document script runs.
 *
 * `addInitScript` runs before the inline `<head>` bootstrap and before the bundle, so the
 * session is present for the first `getSession()` the app makes - including the one during
 * hydration. Signing out is expressed by *removing* the entry rather than by omitting the
 * script, so a context that somehow carries storage from elsewhere cannot leak a session
 * into a spec that asked for the signed-out view.
 */
async function seedSession(page: Page, role: MockRole): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        if (value === null) localStorage.removeItem(key!);
        else localStorage.setItem(key!, value);
      } catch {
        // Blocked storage leaves the page signed out, which the spec reports as a missing
        // prerequisite rather than as a mysterious empty render.
      }
    },
    [authStorageKey(), role === null ? null : syntheticSession()] as const,
  );
}
