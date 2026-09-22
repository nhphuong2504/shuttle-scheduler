import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { REFERENCE, deskTables, type DeskMockPreset } from "./desk-mock";

/**
 * The hermetic application mock.
 *
 * Every Playwright spec runs against this. It exists so that the rendered suite has no
 * dependency on a Supabase project: no credentials, no network, no shared mutable state,
 * and no chance of a test writing to a real tournament.
 *
 * ## Why the whole suite, and not just the two specs that already mocked
 *
 * Before this, only `states.spec.ts` and `desk-layout.spec.ts` intercepted the network.
 * The other eight reached the hosted project. That was wrong for three separate reasons,
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
 * `localStorage` synchronously and makes **no network call**, and derives the role from
 * `supabase.rpc("current_staff_role")`, which is an ordinary REST request this file
 * answers. So seeding one storage entry plus one mocked RPC produces a fully signed-in
 * staff session with no auth server involved.
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

export type MockRole = "admin" | "registrar" | "scorer" | "scheduler" | null;

export interface AppMockOptions {
  /** Which match dataset to serve. `layout` is the eight-court fit fixture. */
  preset?: DeskMockPreset;
  /** The role `current_staff_role` returns. `null` means signed out. */
  role?: MockRole;
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
      id: "00000000-0000-4000-8000-0000000000e2",
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
  const { preset = "layout", role = null } = options;

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

  const rows = deskTables(preset);

  // Re-seeded on every call, so switching role between calls takes effect without a
  // second page.
  await seedSession(page, role);

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

    if (target === "rpc/current_staff_role") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(role),
      });
      return;
    }
    if (target.startsWith("rpc/tournament_readiness")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    const table = target.split("?")[0] ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rows[table] ?? []),
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
