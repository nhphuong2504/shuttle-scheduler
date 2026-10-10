import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import { createPlayer, createTeam } from "@/lib/tournament/actions";
import { fetchCourts, fetchPlacementEntrants } from "@/lib/tournament/data";
import { reportPlacementMatch, startPlacementMatch, syncPlacementEntrants } from "@/lib/tournament/placement-actions";

import {
  createIdentity,
  createOwnedTournament,
  destroyIdentity,
  destroyTournaments,
  serviceClient,
  type DayFixture,
  type TestIdentity,
} from "./env";

/**
 * Starting a match: the server's own physical check, and the reflow a late start earns.
 *
 * WHAT THIS PROVES
 *
 * `20261010000000_start_match_checks_and_reflow.sql` moved two things onto the start path that
 * used to live only in the desk's browser or only on the report path:
 *
 *   1. `assert_can_start_match` refuses a start when a player is already on court in another
 *      match, or when the target court is occupied. The desk's `checkStartConstraints` warned
 *      about both, but two desks race through a stale tab, so the database has to say no.
 *   2. `shift_live_schedule_core` accepts an `in-progress` source now, so starting a match late
 *      - or on a different court than it was published on - reflows the rest of the day the way
 *      reporting a result already did. `live-reflow.test.ts` pins the finished-source rules
 *      (cases (a)-(j), still run by this suite); these are the in-progress ones.
 *
 * THE VIRTUAL CLOCK, AND WHY THE DAY IS IN 2099
 *
 * The reflow floors an in-progress match's expected finish at `statement_timestamp()`:
 * `GREATEST(COALESCE(started_at, scheduled_time) + duration, statement_timestamp())`. A test
 * cannot move that clock, so the fixture has to be *ahead* of it or the floor wins and every
 * successor is judged against the real wall clock instead of the scripted one. The days are
 * therefore in 2099 (`live-reflow.test.ts` dates its own 2020 for the mirror-image reason: its
 * sources are finished, so `ended_at` is read directly and the floor never applies).
 *
 * That makes the window far in the future, which the first-match gate would refuse - so the
 * tournament is created and configured (which is upcoming-only) and then moved to `in_progress`
 * with `forceStatus`, the fixture `integration/env.ts` exposes for exactly this: "a test that
 * needs a tournament already `in_progress` should not first have to satisfy the start gate."
 * The gate itself is what `live-reflow.test.ts` and `lifecycle.test.ts` cover when they start
 * their first match and rely on the side effect.
 *
 * EVERY START IS GIVEN A VIRTUAL `started_at` FIRST
 *
 * `start_placement_match` stamps `started_at = COALESCE(started_at, statement_timestamp())`, so
 * the wall clock would land in a 2099 fixture and - because the reflow keys its queue on
 * `LEAST(scheduled_time, started_at)` - drag the whole court back to the real year. Each helper
 * here writes the virtual start on the still-`scheduled` row first; the RPC then keeps it, which
 * is the same `COALESCE` a correction that re-starts a cleared match relies on.
 *
 * LIMITS
 *
 * Runs against the LOCAL stack only (AGENTS.md): `npx supabase start`, then
 * `npm run integration:target -- local`. It needs a container runtime, so it does not run in
 * the editor by default - `npm run test:integration`.
 */

const TZ = "UTC";
const DAY = "2099-01-04";
const COURT_NUMBERS = [1, 2, 3, 4];

/** A scripted wall time on the fixture's day, in the one form the read-back produces. */
const iso = (time: string) => new Date(`${DAY}T${time}:00Z`).toISOString();

interface Seeded {
  tournamentId: string;
  categoryId: string;
  courtIdByNumber: Map<number, string>;
  entrants: string[];
}

/** Fixtures this suite owns, torn down together so a failure cannot leak them. */
const created: { tournaments: string[]; players: string[] } = { tournaments: [], players: [] };

let admin: TestIdentity;

beforeAll(async () => {
  admin = await createIdentity("admin", "start-checks");
  const { error } = await supabase.auth.signInWithPassword({
    email: admin.email,
    password: admin.password,
  });
  if (error) throw new Error(`signing in the application client failed: ${error.message}`);
}, 120_000);

afterEach(async () => {
  await destroyTournaments(...created.tournaments);
  if (created.players.length > 0) {
    await serviceClient().from("players").delete().in("id", created.players);
  }
  created.tournaments = [];
  created.players = [];
}, 120_000);

afterAll(async () => {
  await supabase.auth.signOut();
  await destroyIdentity(admin);
}, 120_000);

/**
 * An `in_progress` tournament dated ahead of the real clock, with hand-placed matches.
 *
 * The default group rest gap is ten minutes, so a finish anywhere near the virtual "now" is a
 * short rest - which is what the short-rest case needs to be able to trip. Players share nobody
 * unless a case deliberately reuses an entrant index, so a match constrains another only when
 * the case means it to.
 */
async function seed(options: { label: string; entrants: number }): Promise<Seeded> {
  const days: DayFixture[] = [
    { date: DAY, startTime: "09:00", endTime: "18:00", courts: COURT_NUMBERS },
  ];

  const tournamentId = await createOwnedTournament(admin, {
    name: `itest-start-${options.label}-${Date.now().toString(36)}`,
    timezone: TZ,
    days,
    // Past the gate: the window is 2099, so `assert_tournament_can_start_match` would refuse an
    // upcoming tournament. A fixture move, not the transition under test.
    status: "in_progress",
  });
  created.tournaments.push(tournamentId);

  const { data: category, error: categoryError } = await serviceClient()
    .from("categories")
    .select("id")
    .eq("tournament_id", tournamentId)
    .eq("code", "MS")
    .single();
  if (categoryError) throw new Error(`reading the event failed: ${categoryError.message}`);

  const players: string[] = [];
  for (let index = 0; index < options.entrants; index += 1) {
    players.push(await createPlayer({ name: `start ${options.label} p${index}`, gender: "M" }));
  }
  created.players.push(...players);
  for (const playerId of players) {
    await createTeam({ categoryId: category.id, player1: playerId, player2: null });
  }
  await syncPlacementEntrants(category.id);

  const entrants = (await fetchPlacementEntrants(tournamentId)).map((row) => row.id);
  const courts = await fetchCourts(tournamentId);
  const courtIdByNumber = new Map(courts.map((court) => [court.number, court.id]));

  return { tournamentId, categoryId: category.id, courtIdByNumber, entrants };
}

/** Places one round-one match by direct insert, which the planner would never produce. */
async function placeMatch(
  seeded: Seeded,
  spec: { key: string; a: number; b: number; court: number; at: string },
): Promise<string> {
  const courtId = seeded.courtIdByNumber.get(spec.court);
  if (!courtId) throw new Error(`no court ${spec.court}`);
  const { data, error } = await serviceClient()
    .from("placement_matches")
    .insert({
      tournament_id: seeded.tournamentId,
      category_id: seeded.categoryId,
      stage: "round1",
      generation_key: spec.key,
      entrant_a_id: seeded.entrants[spec.a] as string,
      entrant_b_id: seeded.entrants[spec.b] as string,
      court_id: courtId,
      scheduled_time: spec.at,
      status: "scheduled",
      prerequisite_ids: [],
    })
    .select("id")
    .single();
  if (error) throw new Error(`placing ${spec.key} failed: ${error.message}`);
  return data.id;
}

/**
 * Writes the virtual `started_at` on a still-`scheduled` row, then starts it.
 *
 * The write has to come first: `start_placement_match` keeps an existing `started_at`
 * (`COALESCE(started_at, statement_timestamp())`), and the reflow that runs at the end of the
 * same call reads it. Without it the wall clock - 2026 against a 2099 fixture - would be the
 * source's start and drag the day back with it.
 *
 * `court` moves the match when it differs from where it was published, which is the desk's
 * "start it on another court" path; passing the row's own court id (or null) leaves it.
 */
async function startAt(matchId: string, court: string | null, startedAt: string): Promise<void> {
  const { error } = await serviceClient()
    .from("placement_matches")
    .update({ started_at: startedAt })
    .eq("id", matchId);
  if (error) throw new Error(`setting the virtual start failed: ${error.message}`);
  await startPlacementMatch(matchId, court);
}

/** Starts a match at a virtual start, reports a win at a virtual finish, and reflows. */
async function reportAt(
  matchId: string,
  court: string | null,
  startedAt: string,
  endedAt: string,
  tournamentId: string,
): Promise<void> {
  await startAt(matchId, court, startedAt);
  const { error } = await serviceClient()
    .from("placement_matches")
    .update({ started_at: startedAt, ended_at: endedAt })
    .eq("id", matchId);
  if (error) throw new Error(`setting the virtual clock failed: ${error.message}`);
  await reportPlacementMatch(matchId, [{ a: 21, b: 10 }], tournamentId);
}

/** The published times of the given matches, read back after a reflow. */
async function timesOf(ids: string[]): Promise<Map<string, string>> {
  const { data, error } = await serviceClient()
    .from("placement_matches")
    .select("id, scheduled_time")
    .in("id", ids);
  if (error) throw new Error(`reading times failed: ${error.message}`);
  return new Map(data.map((row) => [row.id, new Date(row.scheduled_time as string).toISOString()]));
}

/** One match's row, for the assertions that care about the started-or-moved match itself. */
async function rowOf(id: string) {
  const { data, error } = await serviceClient()
    .from("placement_matches")
    .select("status, scheduled_time, started_at, ended_at, court_id")
    .eq("id", id)
    .single();
  if (error) throw new Error(`reading ${id} failed: ${error.message}`);
  return data;
}

/** Turns the tournament's short-rest block on, the switch no RPC writes yet. */
async function blockOnShortRest(tournamentId: string): Promise<void> {
  const { error } = await serviceClient()
    .from("tournaments")
    .update({ block_start_on_short_rest: true })
    .eq("id", tournamentId);
  if (error) throw new Error(`enabling the short-rest block failed: ${error.message}`);
}

describe("starting a match", () => {
  it("(i) refuses a start when a player is already on court in another match", async () => {
    // The desk's own check reads a snapshot the browser may have held for minutes. The server
    // reads the rows, so a second desk that started entrant 0's other match is seen.
    const seeded = await seed({ label: "i", entrants: 4 });
    const a = await placeMatch(seeded, { key: "i-a", a: 0, b: 1, court: 1, at: iso("09:00") });
    // Shares entrant 0 (a player) with A, on a different court so only the player check fires.
    const b = await placeMatch(seeded, { key: "i-b", a: 0, b: 2, court: 2, at: iso("09:20") });

    await startAt(a, null, iso("09:00"));

    await expect(startAt(b, null, iso("09:20"))).rejects.toThrow(/already playing in another match/i);
    // The refusal rolled the whole start back: B is still scheduled, not on court.
    const row = await rowOf(b);
    expect(row.status).toBe("scheduled");
  }, 120_000);

  it("(ii) refuses a start on a court that already has a match in progress", async () => {
    // Disjoint players, so the only thing the check can be reacting to is the court.
    const seeded = await seed({ label: "ii", entrants: 4 });
    const a = await placeMatch(seeded, { key: "ii-a", a: 0, b: 1, court: 1, at: iso("09:00") });
    const b = await placeMatch(seeded, { key: "ii-b", a: 2, b: 3, court: 1, at: iso("09:20") });

    await startAt(a, null, iso("09:00"));

    await expect(startAt(b, null, iso("09:20"))).rejects.toThrow(/already has a match in progress/i);
    expect((await rowOf(b)).status).toBe("scheduled");
  }, 120_000);

  it("(iii) allows a short rest by default, and refuses it when the tournament opts in", async () => {
    // Default false: the desk is warned, and the start is its decision. A finish one minute
    // before the next start is far inside the ten-minute gap, so the warning is real.
    const seeded = await seed({ label: "iii", entrants: 4 });
    const a = await placeMatch(seeded, { key: "iii-a", a: 0, b: 1, court: 1, at: iso("09:00") });
    // Shares entrant 0 with A and starts a minute after A finishes.
    const b = await placeMatch(seeded, { key: "iii-b", a: 0, b: 2, court: 2, at: iso("09:21") });

    await reportAt(a, null, iso("09:00"), iso("09:20"), seeded.tournamentId);
    await startAt(b, null, iso("09:21"));
    expect((await rowOf(b)).status).toBe("in-progress");
  }, 120_000);

  it("(iii) refuses the same short rest when block_start_on_short_rest is on", async () => {
    const seeded = await seed({ label: "iii-block", entrants: 4 });
    await blockOnShortRest(seeded.tournamentId);

    const a = await placeMatch(seeded, { key: "iiib-a", a: 0, b: 1, court: 1, at: iso("09:00") });
    const b = await placeMatch(seeded, { key: "iiib-b", a: 0, b: 2, court: 2, at: iso("09:21") });

    await reportAt(a, null, iso("09:00"), iso("09:20"), seeded.tournamentId);

    await expect(startAt(b, null, iso("09:21"))).rejects.toThrow(
      /has not had the required \d+ minutes of rest/i,
    );
    expect((await rowOf(b)).status).toBe("scheduled");
  }, 120_000);

  it("(iv) pushes the court's next match by exactly the lateness of a late start", async () => {
    // A match published at 09:00 starts at 09:15. Its successor was published at 09:10 - after
    // the source's published time, before it actually went on court - which is the row the
    // `LEAST(scheduled_time, started_at)` boundary exists to reach: with only the actual start
    // it falls behind the cut and is left overlapping the match in front of it.
    //
    //   m1 09:00, starts 09:15  in-progress; expected end 09:35 (09:15 + 20).
    //   m2 09:10                floor is m1's expected end 09:35, so it moves to 09:35.
    //   m3 09:30  court two     shares nobody and is on no court in the chain: unchanged.
    const seeded = await seed({ label: "iv", entrants: 6 });
    const m1 = await placeMatch(seeded, { key: "iv-1", a: 0, b: 1, court: 1, at: iso("09:00") });
    const m2 = await placeMatch(seeded, { key: "iv-2", a: 2, b: 3, court: 1, at: iso("09:10") });
    const m3 = await placeMatch(seeded, { key: "iv-3", a: 4, b: 5, court: 2, at: iso("09:30") });

    await startAt(m1, null, iso("09:15"));

    const times = await timesOf([m1, m2, m3]);
    // The source is on court, its published time untouched.
    expect(times.get(m1)).toBe(iso("09:00"));
    expect((await rowOf(m1)).status).toBe("in-progress");
    // The successor moves to the source's expected finish: fifteen minutes of lateness.
    expect(times.get(m2)).toBe(iso("09:35"));
    // Nothing else is in the chain.
    expect(times.get(m3)).toBe(iso("09:30"));
  }, 120_000);

  it("(v) changes nothing else when a match starts early", async () => {
    // Starting early must not pull the rest of the day forward, which is the defect the
    // finished-source cases (a) and (b) pin. The reflow may push later and never earlier, so a
    // successor published past the source's *published* time stays where it is.
    //
    //   m1 10:00, starts 09:40  an early start.
    //   m2 10:05  court one     floor is m1's expected end 10:00, before m2's own time: unchanged.
    //   m3 10:15  court two     untouched.
    const seeded = await seed({ label: "v", entrants: 6 });
    const m1 = await placeMatch(seeded, { key: "v-1", a: 0, b: 1, court: 1, at: iso("10:00") });
    const m2 = await placeMatch(seeded, { key: "v-2", a: 2, b: 3, court: 1, at: iso("10:05") });
    const m3 = await placeMatch(seeded, { key: "v-3", a: 4, b: 5, court: 2, at: iso("10:15") });

    await startAt(m1, null, iso("09:40"));

    const times = await timesOf([m1, m2, m3]);
    expect(times.get(m1)).toBe(iso("10:00"));
    expect(times.get(m2)).toBe(iso("10:05"));
    expect(times.get(m3)).toBe(iso("10:15"));
  }, 120_000);

  it("(vi) reflows the target court when a match starts on a different court", async () => {
    // Published on court one at 10:00, started on court two at 10:20. The reflow has to key its
    // queue on the *target* court, and on the earlier of the published time and the actual start,
    // or m2 - published at 10:05, already sitting where the match now physically is - is missed.
    //
    //   m1 10:00  published court one, starts court two at 10:20.
    //   m2 10:05  court two   floor is m1's expected end 10:40, so it moves to 10:40.
    //   m3 10:30  court two   rides behind m2: 10:40 + 20 = 11:00.
    //   m4 10:30  court one   the court the match left: nothing reaches it.
    const seeded = await seed({ label: "vi", entrants: 8 });
    const m1 = await placeMatch(seeded, { key: "vi-1", a: 0, b: 1, court: 1, at: iso("10:00") });
    const m2 = await placeMatch(seeded, { key: "vi-2", a: 2, b: 3, court: 2, at: iso("10:05") });
    const m3 = await placeMatch(seeded, { key: "vi-3", a: 4, b: 5, court: 2, at: iso("10:30") });
    const m4 = await placeMatch(seeded, { key: "vi-4", a: 6, b: 7, court: 1, at: iso("10:30") });

    const target = seeded.courtIdByNumber.get(2);
    await startAt(m1, target as string, iso("10:20"));

    const row = await rowOf(m1);
    // The match is on the court it was started on, at the time it was published.
    expect(row.court_id).toBe(target);
    expect(new Date(row.scheduled_time as string).toISOString()).toBe(iso("10:00"));

    const times = await timesOf([m2, m3, m4]);
    // The match it would have landed on top of is pushed to its expected finish.
    expect(times.get(m2)).toBe(iso("10:40"));
    // And that court's tail follows, preserving the sequence.
    expect(times.get(m3)).toBe(iso("11:00"));
    // The court it left is not part of the chain.
    expect(times.get(m4)).toBe(iso("10:30"));
  }, 120_000);

  it("(vi) control: leaves the target court alone when the move does not collide", async () => {
    // The mirror of the case above: the match moves to court two but its own published time is
    // late enough that court two's next match already sits past its expected finish. The queue
    // reaches the row; nothing pushes it.
    const seeded = await seed({ label: "vi2", entrants: 6 });
    const m1 = await placeMatch(seeded, { key: "vi2-1", a: 0, b: 1, court: 1, at: iso("10:00") });
    const m2 = await placeMatch(seeded, { key: "vi2-2", a: 2, b: 3, court: 2, at: iso("11:00") });

    const target = seeded.courtIdByNumber.get(2);
    await startAt(m1, target as string, iso("10:20"));

    expect((await timesOf([m2])).get(m2)).toBe(iso("11:00"));
  }, 120_000);
});
