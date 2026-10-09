import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import {
  addTournamentDay,
  completeTournament,
  createPlayer,
  createTeam,
  createTournament,
  deleteTournament,
  generatePoolsForCategory,
  reportPoolMatch,
  setTournamentCourts,
  startMatch,
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
 * Nothing presses Start: the first match started on the Desk moves the tournament on, and
 * Complete is the host's own act. Two server guards divide the writes between the states:
 *
 *   - `assert_tournament_configurable` - upcoming only. Events and pool generation.
 *   - `assert_tournament_live`        - in progress only. Reporting matches.
 *
 * So the entries and their pools have to be built while the tournament is still upcoming, the
 * first match starts it, and the results can only be reported after that. Getting that order
 * wrong fails with a guard message that names the state, which is the point of the guard.
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
  it("creates an upcoming tournament, starts it with its first match, reports a complete pool and completes it", async () => {
    // --- Creation ---------------------------------------------------------------
    // One call, complete or not at all: the window, the timezone and an event go in
    // together. The window is in the past so the first-match gate (00:00 of its first date at
    // the venue) has already opened and this test is about the lifecycle rather than the clock.
    tournamentId = await createTournament({
      name: `itest-lifecycle-${Date.now().toString(36)}`,
      venueName: "Integration Test Venue",
      venueTimezone: "America/Chicago",
      startsOn: "2020-01-04",
      endsOn: "2020-01-06",
      events: [
        {
          code: CATEGORY_CODE,
          name: "Men's Singles",
          entryType: "individual",
          gender: "men",
        },
      ],
    });
    expect(tournamentId).toBeTruthy();

    // Creation starts nothing, and a freshly created tournament is complete without a single
    // playing day: those are chosen when the schedule is built.
    const { data: created, error: createdError } = await admin.client
      .from("tournaments")
      .select("status, starts_on, ends_on")
      .eq("id", tournamentId)
      .single();
    if (createdError) throw new Error(createdError.message);
    expect(created?.status).toBe("upcoming");
    expect(created?.starts_on).toBe("2020-01-04");
    expect(created?.ends_on).toBe("2020-01-06");

    // --- Playing days, inside the window ----------------------------------------
    // Not consecutive, and a day outside the window is refused with the window named.
    await addTournamentDay(tournamentId, "2020-01-04");
    await addTournamentDay(tournamentId, "2020-01-06");
    await expect(addTournamentDay(tournamentId, "2020-02-01")).rejects.toThrow(
      /outside the tournament window/i,
    );

    const { data: categories, error: categoryError } = await admin.client
      .from("categories")
      .select("id")
      .eq("tournament_id", tournamentId)
      .eq("code", CATEGORY_CODE);
    if (categoryError) throw new Error(categoryError.message);
    const categoryId = categories?.[0]?.id;
    expect(categoryId, "the created tournament lost its category").toBeTruthy();

    // --- Entries, still upcoming -------------------------------------------------
    // `createTeam` rather than a direct insert: the shape trigger, the per-category cap and
    // the `teams_singles_unique` index all sit on this path. It writes to `teams` directly,
    // so it is not lifecycle-gated - the pool draw below is.
    const teams: Team[] = [];
    for (let i = 0; i < PLAYER_COUNT; i += 1) {
      const playerName = `itest lifecycle player ${i}`;
      // The id comes back from the call: `add_walk_in_player` returns it, which a table insert
      // cannot (PostgreSQL checks `RETURNING` against the read policy, and a fresh walk-in has
      // no entry yet), and the roster is no longer readable as a whole to look it up in.
      const playerId = await createPlayer({ name: playerName, gender: "M" });
      expect(playerId, `creating ${playerName} returned no id`).toBeTruthy();
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
    // the writes that must happen before the first match starts.
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

    // Still upcoming: building the entries and the pools started nothing.
    const { data: beforeStart } = await admin.client
      .from("tournaments")
      .select("status")
      .eq("id", tournamentId)
      .single();
    expect(beforeStart?.status).toBe("upcoming");

    // --- The first match starts the tournament -----------------------------------
    await setTournamentCourts(tournamentId, 2);
    const { data: courts, error: courtError } = await admin.client
      .from("courts")
      .select("id")
      .eq("tournament_id", tournamentId)
      .order("number");
    if (courtError) throw new Error(courtError.message);
    const courtId = courts?.[0]?.id as string;
    expect(courtId, "the tournament has no court").toBeTruthy();

    const first = matches?.[0];
    await startMatch("pool_matches", first?.id as string, courtId);

    const { data: started, error: startedError } = await admin.client
      .from("tournaments")
      .select("status")
      .eq("id", tournamentId)
      .single();
    if (startedError) throw new Error(startedError.message);
    expect(started?.status).toBe("in_progress");

    // A match is on court, so the tournament cannot be completed yet.
    await expect(completeTournament(tournamentId)).rejects.toThrow(/still being played/i);

    // --- Reporting, in progress --------------------------------------------------
    // Deterministic: team A always wins, so the expected winner is knowable rather than
    // merely "someone". `report_pool_result` calls `assert_tournament_live`, which is why
    // this is the first write that needed the tournament to have started. The match that
    // was started is reported like the rest.
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

    // --- Completion, by hand ------------------------------------------------------
    // Nothing is on court any more, so the host's own act now goes through, and it cannot be
    // done twice.
    await completeTournament(tournamentId);
    const { data: done } = await admin.client
      .from("tournaments")
      .select("status")
      .eq("id", tournamentId)
      .single();
    expect(done?.status).toBe("completed");
    await expect(completeTournament(tournamentId)).rejects.toThrow(/already completed/i);
  }, 300_000);
});
