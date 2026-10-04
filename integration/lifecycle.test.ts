import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import {
  createPlayer,
  createTeam,
  createTournament,
  deleteTournament,
  generatePoolsForCategory,
  reportPoolMatch,
  saveTournamentDays,
  saveTournamentEvents,
  startTournament,
} from "@/lib/tournament/actions";
import type { Team } from "@/lib/tournament/data";

import { createIdentity, destroyIdentity, type TestIdentity } from "./env";

/**
 * The full tournament lifecycle against the real backend.
 *
 * This drives the application's OWN action layer - `createTournament`,
 * `saveTournamentEvents`, `generatePoolsForCategory`, `reportPoolMatch` - rather than the
 * underlying RPCs directly. That distinction is the point: the interesting failures are not
 * "does Postgres accept this insert" but "does the sequence the Schedule tab and the Desk
 * actually perform produce a tournament that can be run". Re-implementing the payloads here
 * would test a copy of the logic, and a copy can agree with itself while disagreeing with
 * the app.
 *
 * The client under test is the application's own singleton, signed in as a platform admin.
 * Its configuration is asserted against the test project by `integration/setup-guard.ts`
 * before anything here runs.
 *
 * WHY THE STEPS ARE THIS ORDERED
 *
 * The lifecycle is three states and no reverse edge: `upcoming -> in_progress -> completed`.
 * Two different server guards divide the writes between them, and the order below is what
 * those guards make legal rather than a preference:
 *
 *   - `assert_tournament_configurable` - upcoming only. Days, events and pool generation.
 *   - `assert_tournament_live`        - in progress only. Starting and reporting matches.
 *
 * So the entries and their pools have to be built while the tournament is still upcoming,
 * and the results can only be reported after it has started. Getting that order wrong fails
 * with a guard message that names the state, which is the point of the guard.
 */

const CATEGORY_CODE = "MS";
const PLAYER_COUNT = 4;
/** Four teams form one pool of four, which `pools_size_check` permits. Two would not. */
const EXPECTED_MATCHES = 6;

let admin: TestIdentity;
let tournamentId: string | undefined;
const playerIds: string[] = [];

beforeAll(async () => {
  admin = await createIdentity("admin", "lifecycle");

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
  // left an authenticated admin and its profile row behind.
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
  await step("sign out the application client", async () => {
    await supabase.auth.signOut();
  });
  await step("destroy the identity", async () => {
    await destroyIdentity(admin);
  });

  if (failures.length > 0) {
    // Deliberately a failure, not a warning. A leaked fixture is not a passing run: the
    // leftovers are an auth user, a profile and possibly an active tournament, and the
    // next run inherits all of them.
    throw new Error(`integration teardown did not finish cleanly:\n  - ${failures.join("\n  - ")}`);
  }
}, 120_000);

describe("a tournament can be created and run end to end", () => {
  it("creates an upcoming tournament, promotes it, registers entries and reports a complete pool", async () => {
    // --- Creation ---------------------------------------------------------------
    // `venueName` is not decoration. The start gate refuses a tournament whose `venue_name`
    // is NULL, and the action layer maps an absent value to an empty string rather than to
    // NULL - so leaving it out is precisely what "not ready" looks like, and the promotion
    // below would be refused for a reason that has nothing to do with what this test is
    // proving.
    tournamentId = await createTournament({
      name: `itest-lifecycle-${Date.now().toString(36)}`,
      venueName: "Integration Test Venue",
      venueTimezone: "America/Chicago",
    });
    expect(tournamentId).toBeTruthy();

    // Creation starts nothing. The 3-state machine stays `upcoming` until
    // `start_tournament` is called on it - so this is the real "nothing happened yet"
    // assertion. There is no global active pointer any more, so the status is the whole
    // claim: a freshly created tournament is not live and is nobody's default.
    const { data: created, error: createdError } = await admin.client
      .from("tournaments")
      .select("status")
      .eq("id", tournamentId)
      .single();
    if (createdError) throw new Error(createdError.message);
    expect(created?.status).toBe("upcoming");

    // --- Configuration, while upcoming ------------------------------------------
    // A past date, so `start_tournament`'s derived-start floor is already satisfied and this
    // test is about the lifecycle rather than about the clock.
    await saveTournamentDays(tournamentId, [
      {
        date: "2020-01-04",
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

    const { data: categories, error: categoryError } = await admin.client
      .from("categories")
      .select("id")
      .eq("tournament_id", tournamentId)
      .eq("code", CATEGORY_CODE);
    if (categoryError) throw new Error(categoryError.message);
    const categoryId = categories?.[0]?.id;
    expect(categoryId, "the configured tournament lost its category").toBeTruthy();

    // --- Entries, still upcoming -------------------------------------------------
    // `createTeam` rather than a direct insert: the shape trigger, the per-category cap and
    // the `teams_singles_unique` index all sit on this path. It writes to `teams` directly,
    // so it is not lifecycle-gated - the pool draw below is.
    const teams: Team[] = [];
    for (let i = 0; i < PLAYER_COUNT; i += 1) {
      const playerName = `itest lifecycle player ${i}`;
      await createPlayer({ name: playerName, gender: "M" });
      // The id comes from the roster projection rather than from the insert, which is what
      // the desk does too: `createPlayer` returns nothing because PostgreSQL checks
      // `RETURNING` against the read policy, and a freshly created player has no entry, so
      // nobody may read it back yet. `public_players` is the definer view that carries it.
      const { data: rosterPlayers, error: rosterError } = await admin.client
        .from("public_players")
        .select("id")
        .eq("name", playerName)
        .limit(1);
      if (rosterError) throw new Error(rosterError.message);
      const playerId = rosterPlayers?.[0]?.id;
      expect(playerId, `the roster did not show ${playerName}`).toBeTruthy();
      playerIds.push(playerId as string);
      const team = await createTeam({
        categoryId: categoryId as string,
        player1: playerId as string,
        player2: null,
      });
      teams.push(team as Team);
    }
    expect(teams).toHaveLength(PLAYER_COUNT);

    // --- Pool generation, still upcoming -----------------------------------------
    // `apply_pool_generation` calls `assert_tournament_configurable`, so this is the last of
    // the writes that must happen before the tournament starts.
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

    // --- Promotion, upcoming -> in progress ---------------------------------------
    // Readiness is re-checked here, so a tournament missing a day, a court or an event is
    // refused. That refusal is the assertion: reaching this line proves the wizard's output
    // satisfies the gate.
    await startTournament(tournamentId);

    const { data: started, error: startedError } = await admin.client
      .from("tournaments")
      .select("status")
      .eq("id", tournamentId)
      .single();
    if (startedError) throw new Error(startedError.message);
    expect(started?.status).toBe("in_progress");

    // The machine has no reverse edge, so the transition is not merely applied - it cannot
    // be applied twice. A second start would mean `status` is not the guard's only input.
    await expect(startTournament(tournamentId)).rejects.toThrow(/already started/i);

    // --- Reporting, in progress --------------------------------------------------
    // Deterministic: team A always wins, so the expected winner is knowable rather than
    // merely "someone". `report_pool_result` calls `assert_tournament_live`, which is why
    // this is the first write that needed the promotion above.
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
