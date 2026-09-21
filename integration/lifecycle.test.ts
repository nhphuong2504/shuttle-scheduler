import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import {
  activateTournament,
  createPlayer,
  createTeam,
  createTournamentDraft,
  deleteTournament,
  generatePoolsForCategory,
  reportPoolMatch,
  saveTournamentDays,
  saveTournamentEvents,
} from "@/lib/tournament/actions";
import type { Team } from "@/lib/tournament/data";

import { createStaffIdentity, destroyStaffIdentity, type TestIdentity } from "./env";

/**
 * The full tournament lifecycle against the real backend.
 *
 * This drives the application's OWN action layer - `createTournamentDraft`,
 * `saveTournamentEvents`, `generatePoolsForCategory`, `reportPoolMatch` - rather than the
 * underlying RPCs directly. That distinction is the point: the interesting failures are not
 * "does Postgres accept this insert" but "does the sequence the Schedule tab and the Desk
 * actually perform produce a tournament that can be run". Re-implementing the payloads here
 * would test a copy of the logic, and a copy can agree with itself while disagreeing with
 * the app.
 *
 * The client under test is the application's own singleton, signed in as an admin. Its
 * configuration is asserted against the test project by `integration/setup-guard.ts` before
 * anything here runs.
 *
 * WHY THE STEPS ARE THIS ORDERED
 *
 * A draft must be days-and-events complete before `activate_tournament` will promote it, and
 * pool generation refuses a category it has already drawn without `force`. The order below
 * mirrors the wizard for that reason, and a failure at any step is reported as the step that
 * failed rather than as a puzzling error from the next one.
 */

const CATEGORY_CODE = "MS";
const PLAYER_COUNT = 4;
/** Four teams form one pool of four, which `pools_size_check` permits. Two would not. */
const EXPECTED_MATCHES = 6;

let admin: TestIdentity;
let tournamentId: string | undefined;
const playerIds: string[] = [];
let previouslyActiveTournamentId: string | null = null;

beforeAll(async () => {
  admin = await createStaffIdentity("admin", "lifecycle");

  // Activating a tournament deactivates whatever was active. On a shared test project that
  // is someone else's fixture, so the previous holder is captured and restored in teardown
  // rather than left deactivated as a side effect of running these tests.
  const { data } = await admin.client
    .from("tournaments")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();
  previouslyActiveTournamentId = data?.id ?? null;

  // Signing in the application's own client, not a second one: the action layer imports this
  // singleton, so this is what makes its calls authenticated.
  const { error } = await supabase.auth.signInWithPassword({
    email: admin.email,
    password: admin.password,
  });
  if (error) throw new Error(`signing in the application client failed: ${error.message}`);
}, 120_000);

afterAll(async () => {
  // Every step is guarded independently, and the reason is not tidiness. This teardown used
  // to run as one straight sequence with the identity deletion last, so a failure anywhere
  // above it skipped the only step that matters for hygiene. That is exactly how two
  // `itest-lifecycle-*` identities leaked onto the shared project: the run went red, and it
  // left an authenticated admin and its `staff_roles` row behind.
  //
  // Teardown failing is survivable. Teardown failing partway, silently, and leaving a login
  // behind on a project every future run shares is not - so failures are collected and
  // reported rather than abandoned.
  const failures: string[] = [];
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (cause) {
      failures.push(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  await step("delete the tournament", async () => {
    // Cascades to days, categories, teams, pools and matches.
    if (tournamentId) await deleteTournament(tournamentId);
  });
  await step("delete the players", async () => {
    if (playerIds.length > 0) await admin.client.from("players").delete().in("id", playerIds);
  });
  await step("restore the previously active tournament", async () => {
    if (previouslyActiveTournamentId) {
      await admin.client.rpc("set_active_tournament", {
        p_tournament_id: previouslyActiveTournamentId,
      } as never);
    }
  });
  await step("sign out the application client", async () => {
    await supabase.auth.signOut();
  });
  await step("destroy the staff identity", async () => {
    await destroyStaffIdentity(admin);
  });

  if (failures.length > 0) {
    // Deliberately a failure, not a warning. A leaked fixture is not a passing run: the
    // leftovers are an auth user, a staff row and possibly an active tournament, and the
    // next run inherits all of them.
    throw new Error(`integration teardown did not finish cleanly:\n  - ${failures.join("\n  - ")}`);
  }
}, 120_000);

describe("a tournament can be created and run end to end", () => {
  it("creates a draft, promotes it, registers entries and reports a complete pool", async () => {
    // --- Setup -----------------------------------------------------------------
    // `venueName` is not decoration. The activation gate refuses a tournament whose
    // `venue_name` is NULL, and `create_tournament_draft` maps an absent value to NULL
    // rather than to an empty string - so leaving it out is precisely what "not ready"
    // looks like, and the promotion below would be refused for a reason that has nothing
    // to do with what this test is trying to prove.
    tournamentId = await createTournamentDraft({
      name: `itest-lifecycle-${Date.now().toString(36)}`,
      venueName: "Integration Test Venue",
      venueTimezone: "America/Chicago",
    });
    expect(tournamentId).toBeTruthy();

    await saveTournamentDays(tournamentId, [
      {
        date: "2026-11-07",
        startTime: "09:00",
        endTime: "18:00",
        courts: [1, 2],
        breaks: [],
      },
    ]);

    await saveTournamentEvents(tournamentId, [
      {
        code: CATEGORY_CODE,
        name: "Men's Singles",
        entryType: "individual",
        gender: "men",
      },
    ]);

    // --- Promotion -------------------------------------------------------------
    // Readiness is re-checked here, so a tournament missing a day, a court or a category is
    // refused. That refusal is the assertion: reaching this line proves the wizard's output
    // satisfies the gate.
    await activateTournament(tournamentId);

    const { data: activated, error: readError } = await admin.client
      .from("tournaments")
      .select("id, status, is_active")
      .eq("id", tournamentId)
      .single();
    if (readError) throw new Error(readError.message);
    expect(activated?.status).toBe("in_progress");
    expect(activated?.is_active).toBe(true);

    const { data: categories, error: categoryError } = await admin.client
      .from("categories")
      .select("id")
      .eq("tournament_id", tournamentId)
      .eq("code", CATEGORY_CODE);
    if (categoryError) throw new Error(categoryError.message);
    const categoryId = categories?.[0]?.id;
    expect(categoryId, "the activated tournament lost its category").toBeTruthy();

    // --- Registration ----------------------------------------------------------
    const teams: Team[] = [];
    for (let i = 0; i < PLAYER_COUNT; i += 1) {
      const player = await createPlayer({
        name: `itest lifecycle player ${i}`,
        gender: "M",
      });
      playerIds.push(player.id);
      // `createTeam` rather than a direct insert: the shape trigger, the per-category cap and
      // the `teams_singles_unique` index all sit on this path.
      const team = await createTeam({
        categoryId: categoryId as string,
        player1: player.id,
        player2: null,
      });
      teams.push(team as Team);
    }
    expect(teams).toHaveLength(PLAYER_COUNT);

    // --- Pool generation -------------------------------------------------------
    await generatePoolsForCategory(categoryId as string, teams);

    const { data: pools, error: poolError } = await admin.client
      .from("pools")
      .select("id, name, size")
      .eq("category_id", categoryId as string);
    if (poolError) throw new Error(poolError.message);
    expect(pools).toHaveLength(1);
    expect(pools?.[0]?.size).toBe(PLAYER_COUNT);

    const { data: matches, error: matchError } = await admin.client
      .from("pool_matches")
      .select("id, status, team_a_id, team_b_id, winner_id")
      .eq("pool_id", pools?.[0]?.id as string);
    if (matchError) throw new Error(matchError.message);
    // Every pair plays once: 4 teams -> 6 matches. A wrong count means the round-robin
    // construction is broken, which the standings table would then report as a wrong winner.
    expect(matches).toHaveLength(EXPECTED_MATCHES);
    expect(matches?.every((m) => m.status === "scheduled")).toBe(true);

    // --- Reporting -------------------------------------------------------------
    // Deterministic: team A always wins, so the expected winner is knowable rather than
    // merely "someone".
    for (const match of matches ?? []) {
      await reportPoolMatch(match.id, 21, 10);
    }

    const { data: reported, error: reportedError } = await admin.client
      .from("pool_matches")
      .select("id, status, score_a, score_b, winner_id, team_a_id")
      .eq("pool_id", pools?.[0]?.id as string);
    if (reportedError) throw new Error(reportedError.message);

    expect(reported).toHaveLength(EXPECTED_MATCHES);
    for (const match of reported ?? []) {
      expect(match.status, `match ${match.id} did not reach a reported state`).toBe("reported");
      expect(match.score_a).toBe(21);
      expect(match.score_b).toBe(10);
      // The winner must be the side that was given 21, and the database must agree - this is
      // the scoring rule, not a presentation detail.
      expect(match.winner_id, `match ${match.id} recorded no winner`).toBe(match.team_a_id);
    }
  }, 300_000);
});
