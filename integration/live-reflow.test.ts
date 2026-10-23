import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import { createPlayer, createTeam } from "@/lib/tournament/actions";
import { fetchCourts, fetchPlacementEntrants, fetchScheduleConflicts } from "@/lib/tournament/data";
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
 * The live reflow, driven through the real RPCs against a real backend.
 *
 * WHAT THIS PROVES
 *
 * `shift_live_schedule_core` is the code that moves the rest of a court's day when a result
 * lands. It is arithmetic over the rows, so `simulation.test.ts` already plays a whole event
 * through it - but a simulation checks that the eventual answer is playable, not that each
 * specific rule (never earlier, never into a break, never off this day, held at the close)
 * is what the code does. These cases pin those rules one at a time, on hand-placed matches,
 * because the rules are the whole point of the migration and a simulation is happy to be
 * right for the wrong reason.
 *
 * THE VIRTUAL CLOCK
 *
 * The days are dated in 2020 so the first-match gate is open, and `report_placement_result`
 * stamps `ended_at = COALESCE(ended_at, now())`. Each case writes the source's whole virtual
 * window (service role, a fixture and never an assertion) BEFORE reporting - `ended_at` at the
 * scripted finish and `started_at` one slot before it - so the reflow reads a virtual span
 * instead of the wall clock and the played row has a real window rather than an inverted one.
 * Every other match is left `scheduled`, so the only instant the reflow can read from the clock
 * is the source's own - which the fixture already set - and the run is deterministic.
 *
 * THE TOURNAMENT IS CONFIGURED FIRST, THEN STARTED
 *
 * A tournament is only configurable while `upcoming`, so `seed` leaves it there and does not
 * force a status: writing days, teams and entrants happens before it starts. The move to
 * `in_progress` is then the same side effect `simulation.test.ts` and `lifecycle.test.ts` rely
 * on - starting a match in `reportAt` - because `assert_tournament_live`, which reporting
 * needs, refuses an upcoming tournament and `start_tournament` is a button that requires
 * readiness this fixture does not walk.
 *
 * A COURT AND A DAY ARE NOT THE SAME THING
 *
 * Each case builds its own tournament with two days and three courts, and places matches by
 * direct insert rather than through the planner. That is deliberate: the planner would only
 * produce schedules it already believes are safe, and the reflow is exactly the code that has
 * to cope when a result makes one unsafe.
 *
 * LIMITS
 *
 * Runs against the LOCAL stack only (AGENTS.md): `npx supabase start`, then
 * `npm run integration:target -- local`. It needs a container runtime, so it does not run in
 * the editor by default - `npm run test:integration`.
 */

const TZ = "UTC";
const DAY1 = "2020-01-04";
const DAY2 = "2020-01-05";
const COURT_NUMBERS = [1, 2, 3];

/** The tournaments here are created without timings, so this is `group_slot_minutes`'s default
 * and the length of one placement match. Reported matches are given a virtual start one slot
 * before their finish so their window is real rather than inverted. */
const SLOT_MINUTES = 20;

/**
 * A scripted wall-clock time, in the one form the read-back uses.
 *
 * Postgres returns a `timestamptz` with milliseconds, and `timesOf` canonicalises with
 * `toISOString()`, so it gives `2020-01-04T10:00:00.000Z`. Building the expectation by string
 * concatenation instead would give `2020-01-04T10:00:00Z` and fail on `.000` alone. Going
 * through `Date` keeps both sides identical and hides nothing about the value.
 */
const iso = (day: string, time: string) => new Date(`${day}T${time}:00Z`).toISOString();

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
  admin = await createIdentity("admin", "live-reflow");
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
 * A tournament with hand-placed matches ready to report.
 *
 * Configuring a tournament - writing its days, teams and entrants - is only allowed while it
 * is `upcoming` ("A tournament can only be configured before it starts"), so this is left
 * upcoming here. It is moved to `in_progress` later, by starting a match in `reportAt`, which
 * is the transition `simulation.test.ts` and `lifecycle.test.ts` both rely on.
 *
 * `entrants` are singles entries whose players share nobody, so a match never constrains
 * another through a rest gap unless a case deliberately pairs two entrants twice.
 */
async function seed(options: {
  label: string;
  entrants: number;
  day1End?: string;
  day2?: boolean;
  break?: { start: string; end: string };
}): Promise<Seeded> {
  const days: DayFixture[] = [
    {
      date: DAY1,
      startTime: "09:00",
      endTime: options.day1End ?? "17:00",
      courts: COURT_NUMBERS,
    },
  ];
  if (options.day2) {
    days.push({ date: DAY2, startTime: "09:00", endTime: "17:00", courts: COURT_NUMBERS });
  }

  const tournamentId = await createOwnedTournament(admin, {
    name: `itest-reflow-${options.label}-${Date.now().toString(36)}`,
    timezone: TZ,
    days,
  });
  created.tournaments.push(tournamentId);

  const { data: category, error: categoryError } = await serviceClient()
    .from("categories")
    .select("id")
    .eq("tournament_id", tournamentId)
    .eq("code", "MS")
    .single();
  if (categoryError) throw new Error(`reading the event failed: ${categoryError.message}`);

  const { data: dayRows, error: dayError } = await serviceClient()
    .from("tournament_days")
    .select("id, day_number")
    .eq("tournament_id", tournamentId)
    .eq("day_number", 1)
    .single();
  if (dayError) throw new Error(`reading the day failed: ${dayError.message}`);

  if (options.break) {
    const { error } = await serviceClient().from("tournament_day_breaks").insert({
      tournament_id: tournamentId,
      day_id: dayRows.id,
      label: "Test break",
      start_time: options.break.start,
      end_time: options.break.end,
    });
    if (error) throw new Error(`writing the break failed: ${error.message}`);
  }

  const players: string[] = [];
  for (let index = 0; index < options.entrants; index += 1) {
    players.push(await createPlayer({ name: `reflow ${options.label} p${index}`, gender: "M" }));
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
  spec: {
    key: string;
    a: number;
    b: number;
    court: number;
    at: string;
    prerequisites?: string[];
  },
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
      prerequisite_ids: spec.prerequisites ?? [],
    })
    .select("id")
    .single();
  if (error) throw new Error(`placing ${spec.key} failed: ${error.message}`);
  return data.id;
}

/**
 * Starts a match, reports it at a virtual finish, and lets the reflow run.
 *
 * Starting it first is what moves the tournament to `in_progress`: `start_placement_match`
 * flips an upcoming tournament as a side effect (`mark_tournament_started`), which is the
 * transition `simulation.test.ts` and `lifecycle.test.ts` get from starting their first match.
 * Reporting needs `assert_tournament_live`, so this cannot be skipped.
 *
 * The service role then writes the match's whole virtual window, `started_at` and `ended_at`
 * together, because `report_placement_result` preserves `ended_at` with `COALESCE(ended_at,
 * now())` but the start has already been stamped with the wall clock - and 2026 is not 2020.
 * A row with `started_at > ended_at` is an inverted window: the reflow reads
 * `COALESCE(fixed.actual_start, ...)` as the far edge of a done match's span, and
 * `schedule_conflicts` reads `eff_start = COALESCE(started_at, scheduled_time)`, so a played
 * match whose span ran backwards would block and be flagged against nothing. The virtual start
 * is one slot before the finish, the same length the planner gives the match. Both columns are
 * written by the service role, a fixture and never an assertion.
 */
async function reportAt(matchId: string, endedAt: string, tournamentId: string): Promise<void> {
  await startPlacementMatch(matchId, null);
  const startedAt = new Date(Date.parse(endedAt) - SLOT_MINUTES * 60_000).toISOString();
  const { error } = await serviceClient()
    .from("placement_matches")
    .update({ ended_at: endedAt, started_at: startedAt })
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

describe("live reflow", () => {
  it("(a) leaves the rest of the court alone, and never pulls it earlier", async () => {
    // A match that finishes EARLY is the sharper case: the old core floored the next start at
    // the previous match's real end, so an early finish dragged the whole queue forward. The
    // reflow may push a match later and never earlier.
    const seeded = await seed({ label: "a", entrants: 4 });
    const m1 = await placeMatch(seeded, { key: "a-1", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });
    const m2 = await placeMatch(seeded, { key: "a-2", a: 2, b: 3, court: 1, at: iso(DAY1, "10:00") });

    // Finishes at 09:05, fifty-five minutes before the next match is due.
    await reportAt(m1, iso(DAY1, "09:05"), seeded.tournamentId);

    const times = await timesOf([m2]);
    expect(times.get(m2)).toBe(iso(DAY1, "10:00"));
  });

  it("(b) keeps a day-two match on day two after a day-one overrun", async () => {
    // The day filter is defect 2's fix: the first match of day two on a court must not be
    // dragged back toward the end of day one.
    const seeded = await seed({ label: "b", entrants: 4, day2: true });
    const m1 = await placeMatch(seeded, { key: "b-1", a: 0, b: 1, court: 1, at: iso(DAY1, "16:40") });
    const m2 = await placeMatch(seeded, { key: "b-2", a: 2, b: 3, court: 1, at: iso(DAY2, "09:00") });

    // Runs twenty minutes past day one's close; nothing on day one follows it.
    await reportAt(m1, iso(DAY1, "17:20"), seeded.tournamentId);

    const times = await timesOf([m2]);
    expect(times.get(m2)).toBe(iso(DAY2, "09:00"));
  });

  it("(c) pushes a dependent on another court behind its prerequisite", async () => {
    // A match that waits on another is part of the cascade even across courts: the queue is
    // seeded with the source's dependents, not only the source's own court.
    const seeded = await seed({ label: "c", entrants: 4 });
    const prereq = await placeMatch(seeded, {
      key: "c-prereq",
      a: 0,
      b: 1,
      court: 1,
      at: iso(DAY1, "09:00"),
    });
    const dependent = await placeMatch(seeded, {
      key: "c-dependent",
      a: 2,
      b: 3,
      court: 2,
      at: iso(DAY1, "09:00"),
      prerequisites: [prereq],
    });

    // The prerequisite runs to 09:50, so the dependent cannot start at 09:00.
    await reportAt(prereq, iso(DAY1, "09:50"), seeded.tournamentId);

    const times = await timesOf([dependent]);
    expect(times.get(dependent)).toBe(iso(DAY1, "09:50"));
  });

  it("(d) holds the match that would run past closing time, and its court's tail with it", async () => {
    // Day one closes at 11:00 and a placement match is 20 minutes, so the last start that
    // finishes inside the day is 10:40.
    //
    //   m1 09:00 -> 10:20  source; reports forty minutes past its slot.
    //   m2 09:30 -> 10:20  prev_end = 10:20, so GREATEST(09:30, 10:20) = 10:20; ends 10:40.
    //   m3 10:00 -> 10:40  prev_end = 10:40, GREATEST(10:00, 10:40) = 10:40; ends 11:00, exactly
    //                      the close, so it is inside the day and is written rather than held.
    //   m4 10:50           prev_end = 11:00, so pushed to 11:00 and would end 11:20, past the
    //                      close: HELD, and it keeps 10:50. The reflow moved this one, so this
    //                      is a spill it would create - not one it merely found.
    //   m5 10:55           the tail behind m4 on the same court: held with it, keeps 10:55.
    const seeded = await seed({ label: "d", entrants: 10, day1End: "11:00" });
    const m1 = await placeMatch(seeded, { key: "d-1", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });
    const m2 = await placeMatch(seeded, { key: "d-2", a: 2, b: 3, court: 1, at: iso(DAY1, "09:30") });
    const m3 = await placeMatch(seeded, { key: "d-3", a: 4, b: 5, court: 1, at: iso(DAY1, "10:00") });
    const m4 = await placeMatch(seeded, { key: "d-4", a: 6, b: 7, court: 1, at: iso(DAY1, "10:50") });
    const m5 = await placeMatch(seeded, { key: "d-5", a: 8, b: 9, court: 1, at: iso(DAY1, "10:55") });

    // The source runs to 10:20, forty minutes past its slot, which pushes the whole queue.
    await reportAt(m1, iso(DAY1, "10:20"), seeded.tournamentId);

    const times = await timesOf([m2, m3, m4, m5]);
    // Before the held point: shifted and written. m3 rides directly behind the overrun m2.
    expect(times.get(m2)).toBe(iso(DAY1, "10:20"));
    expect(times.get(m3)).toBe(iso(DAY1, "10:40"));
    // The spill and its court's tail: held, so unchanged at their published times.
    expect(times.get(m4)).toBe(iso(DAY1, "10:50"));
    expect(times.get(m5)).toBe(iso(DAY1, "10:55"));

    const conflicts = await fetchScheduleConflicts(seeded.tournamentId);
    const held = conflicts.filter((row) => row.match_id === m4);
    expect(held.length).toBeGreaterThan(0);
    // m4 published at 10:50 runs to 11:10, past the close, so the read over the rows reports
    // it - which is where a past-closing time belongs, held or not.
    expect(held.map((row) => row.conflict_kind)).toContain("past_closing");
  });

  it("(e) never pushes a match into a day break", async () => {
    // The break pass is part of the loop now: a cascade that would land inside a break is
    // stepped wholly past it, after the player windows and before closing time.
    const seeded = await seed({
      label: "e",
      entrants: 4,
      break: { start: "10:00", end: "11:00" },
    });
    const m1 = await placeMatch(seeded, { key: "e-1", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });
    const m2 = await placeMatch(seeded, { key: "e-2", a: 2, b: 3, court: 1, at: iso(DAY1, "09:40") });

    // m2 would be reflowed to 09:50-10:10, straddling the 10:00 break, so it moves to 11:00.
    await reportAt(m1, iso(DAY1, "09:50"), seeded.tournamentId);

    const times = await timesOf([m2]);
    expect(times.get(m2)).toBe(iso(DAY1, "11:00"));
  });

  it("(f) still reflows an unrelated chain while another is held, and the held match pulls nobody", async () => {
    // Court one's tail is held at the close, but court two's chain is pulled by a match that DID
    // move - the source itself, whose overrun the shared player has to wait out. The held match
    // shares a player with a match on court three, and that match must stay put: a held match
    // never propagates.
    //
    //   a1 09:00 -> 10:25  source; reports twenty-five minutes past its slot.
    //   a2 09:30 -> 10:25  prev_end = a1's real end 10:25, GREATEST(09:30, 10:25) = 10:25.
    //   a3 10:40           prev_end = 10:25 + 20 = 10:45, so pushed to 10:45 and would end
    //                      11:05, past the 11:00 close: HELD, and it keeps 10:40.
    //   a4 10:55           the tail behind a3 on the same court: held with it, keeps 10:55.
    //   b1 09:35 -> 10:35  court two, shares a player with a1: rest floor = 10:25 + 10 = 10:35,
    //                      which fits inside the day, so court two reflows although court one
    //                      is held.
    //   c1 10:30           court three, shares a player with the held a3: reached by nothing.
    const seeded = await seed({ label: "f", entrants: 10, day1End: "11:00" });
    const a1 = await placeMatch(seeded, { key: "f-a1", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });
    const a2 = await placeMatch(seeded, { key: "f-a2", a: 2, b: 3, court: 1, at: iso(DAY1, "09:30") });
    const a3 = await placeMatch(seeded, { key: "f-a3", a: 4, b: 5, court: 1, at: iso(DAY1, "10:40") });
    const a4 = await placeMatch(seeded, { key: "f-a4", a: 6, b: 7, court: 1, at: iso(DAY1, "10:55") });
    // Shares entrant 0 (a player) with the source, so the source's real end pulls it.
    const b1 = await placeMatch(seeded, { key: "f-b1", a: 0, b: 9, court: 2, at: iso(DAY1, "09:35") });
    // Shares entrant 4 with the held a3, on its own court: it must not move.
    const c1 = await placeMatch(seeded, { key: "f-c1", a: 4, b: 8, court: 3, at: iso(DAY1, "10:30") });

    await reportAt(a1, iso(DAY1, "10:25"), seeded.tournamentId);

    const times = await timesOf([a2, a3, a4, b1, c1]);
    expect(times.get(a2)).toBe(iso(DAY1, "10:25"));
    // Held: pushed to 10:45, which would end past the 11:00 close, so it keeps 10:40.
    expect(times.get(a3)).toBe(iso(DAY1, "10:40"));
    // Its court's tail: held with it, so it keeps its published time too.
    expect(times.get(a4)).toBe(iso(DAY1, "10:55"));
    // Court two reflowed anyway: a1 ended at 10:25, and b1 shares a player with it.
    expect(times.get(b1)).toBe(iso(DAY1, "10:35"));
    // Court three untouched: a held match drags nobody.
    expect(times.get(c1)).toBe(iso(DAY1, "10:30"));
  });

  it("(g) never flags a match that has already been played", async () => {
    // A played match with short rest, or one that overlapped on the court at the time, is
    // history the desk already accepted. Only a still-scheduled match is actionable.
    const seeded = await seed({ label: "g", entrants: 10 });
    const played = await placeMatch(seeded, { key: "g-1", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });
    // Overlaps `played` on the same court.
    const overlapped = await placeMatch(seeded, {
      key: "g-2",
      a: 2,
      b: 3,
      court: 1,
      at: iso(DAY1, "09:00"),
    });
    // Shares entrant 0 with `played`, and starts before its rest window allows.
    const shortRest = await placeMatch(seeded, {
      key: "g-3",
      a: 0,
      b: 4,
      court: 2,
      at: iso(DAY1, "09:05"),
    });
    // A still-scheduled overlap the reflows above cannot reach: a third court whose players
    // appear in nothing else, so no move pulls it and the pair stays overlapping. Without it a
    // broken read that returned nothing would pass this test vacuously.
    const liveA = await placeMatch(seeded, { key: "g-4", a: 5, b: 6, court: 3, at: iso(DAY1, "12:00") });
    const liveB = await placeMatch(seeded, { key: "g-5", a: 7, b: 8, court: 3, at: iso(DAY1, "12:10") });

    await reportAt(played, iso(DAY1, "09:20"), seeded.tournamentId);
    await reportAt(overlapped, iso(DAY1, "09:20"), seeded.tournamentId);
    await reportAt(shortRest, iso(DAY1, "09:20"), seeded.tournamentId);

    const conflicts = await fetchScheduleConflicts(seeded.tournamentId);
    const playedIds = new Set([played, shortRest, overlapped]);
    expect(conflicts.some((row) => playedIds.has(row.match_id))).toBe(false);
    // And the read still works: the schedules that are still to play are the ones reported.
    const liveIds = new Set(conflicts.map((row) => row.match_id));
    expect(liveIds.has(liveA) || liveIds.has(liveB)).toBe(true);
  });

  it("(h) does not flag a scheduled match just because its time has passed", async () => {
    // Lateness is not a conflict - the desk has its own overdue alert - so a scheduled match
    // the clock has overtaken, with nothing else wrong, produces no row at all.
    const seeded = await seed({ label: "h", entrants: 2 });
    const m1 = await placeMatch(seeded, { key: "h-1", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });

    const conflicts = await fetchScheduleConflicts(seeded.tournamentId);
    expect(conflicts.filter((row) => row.match_id === m1)).toEqual([]);
  });

  it("(i) pushes a co-player on another court behind the source's real finish", async () => {
    // An overrun is another court's problem when the two matches share a player. The
    // co-player was reached only once some *other* match had moved, so an overrun that landed
    // on top of it left a reported result overlapping a scheduled match for the same player.
    const seeded = await seed({ label: "i", entrants: 5 });
    const a = await placeMatch(seeded, { key: "i-a", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });
    // Shares entrant 0 with A, on another court, published just after A's planned 09:20 finish
    // - but inside the ten-minute rest A's real 09:50 end demands, which is 10:00.
    const b = await placeMatch(seeded, { key: "i-b", a: 0, b: 2, court: 2, at: iso(DAY1, "09:30") });
    // Unrelated players on their own court: nothing may reach it.
    const c = await placeMatch(seeded, { key: "i-c", a: 3, b: 4, court: 3, at: iso(DAY1, "09:30") });

    await reportAt(a, iso(DAY1, "09:50"), seeded.tournamentId);

    const times = await timesOf([b, c]);
    // Exactly the source's real end plus the rest gap: the co-player's own published time is a
    // floor it may be pushed later from, never earlier.
    expect(times.get(b)).toBe(iso(DAY1, "10:00"));
    // Court three is not in the chain at all.
    expect(times.get(c)).toBe(iso(DAY1, "09:30"));
  });

  it("(i) control: keeps a co-player on another court when the rest already fits", async () => {
    // The control for the case above: the same shared-player chain, but the co-player is
    // published past the source's real end plus the rest gap. The new seed only has to reach
    // it, so it must not move it.
    const seeded = await seed({ label: "i2", entrants: 5 });
    const a = await placeMatch(seeded, { key: "i2-a", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });
    // Shares entrant 0 with A; 10:05 is past the 10:00 the rest demands.
    const b = await placeMatch(seeded, { key: "i2-b", a: 0, b: 2, court: 2, at: iso(DAY1, "10:05") });
    const c = await placeMatch(seeded, { key: "i2-c", a: 3, b: 4, court: 3, at: iso(DAY1, "09:30") });

    await reportAt(a, iso(DAY1, "09:50"), seeded.tournamentId);

    const times = await timesOf([b, c]);
    expect(times.get(b)).toBe(iso(DAY1, "10:05"));
    expect(times.get(c)).toBe(iso(DAY1, "09:30"));
  });

  it("(j) leaves an already-past-closing match alone when the reflow is not moving it", async () => {
    // The close bounds what the reflow *writes*, not what it reads. A match whose published
    // time already crosses 11:00 is not something this run moved, so it is neither held nor
    // written: it keeps its published time, and its court's tail is still processed normally.
    // Reporting it is `schedule_conflicts`' `past_closing`.
    //
    //   m1 09:00 -> 09:40  source; reports twenty minutes past its slot.
    //   m2 09:30 -> 09:40  prev_end = 09:40, GREATEST(09:30, 09:40) = 09:40: a normal shift that
    //                      fits, so the case still shows the loop doing real work.
    //   m3 10:45           prev_end = 09:40 + 20 = 10:00, so GREATEST(10:45, 10:00) = 10:45 -
    //                      its own published time, not a move. It finishes 11:05, past the
    //                      close, but because the reflow did not move it, it is NOT held and it
    //                      keeps 10:45.
    //   m4 11:10           prev_end = 10:45 + 20 = 11:05, and its published start is later still,
    //                      so it is not moved either - kept at 11:10, not held. A same-court
    //                      successor of a past-closing match cannot be validly pushed (its floor
    //                      is already past the close), so "handled normally" here is left
    //                      untouched rather than frozen as a held tail.
    const seeded = await seed({ label: "j", entrants: 8, day1End: "11:00" });
    const m1 = await placeMatch(seeded, { key: "j-1", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });
    const m2 = await placeMatch(seeded, { key: "j-2", a: 2, b: 3, court: 1, at: iso(DAY1, "09:30") });
    const m3 = await placeMatch(seeded, { key: "j-3", a: 4, b: 5, court: 1, at: iso(DAY1, "10:45") });
    const m4 = await placeMatch(seeded, { key: "j-4", a: 6, b: 7, court: 1, at: iso(DAY1, "11:10") });

    await reportAt(m1, iso(DAY1, "09:40"), seeded.tournamentId);

    const times = await timesOf([m2, m3, m4]);
    expect(times.get(m2)).toBe(iso(DAY1, "09:40"));
    expect(times.get(m3)).toBe(iso(DAY1, "10:45"));
    expect(times.get(m4)).toBe(iso(DAY1, "11:10"));

    // And the read still reports the spill: a past-closing time belongs to schedule_conflicts,
    // whether or not the reflow touched the row.
    const conflicts = await fetchScheduleConflicts(seeded.tournamentId);
    const pastClosing = conflicts.filter((row) => row.match_id === m3);
    expect(pastClosing.map((row) => row.conflict_kind)).toContain("past_closing");
  });

  it("(k) does not chase a prerequisite that is queued behind its dependent on the same court", async () => {
    // Viet Nam Open 2026. The held entrant's second make-up (m2) waits for the first (m1), but m2
    // was published ahead of it on the same court. The court keeps its order and the prerequisite
    // keeps its order, so no move satisfies both: every reflow pushed m2 behind m1 and m1 behind m2,
    // a slot plus rest later each time, for as long as results kept arriving.
    //
    //   s1 09:00, s2 09:20  unrelated earlier matches on court one; each report seeds the tail.
    //   m2 11:00            waits for m1, published first.
    //   m1 11:20            the prerequisite, queued behind it.
    //
    // m1 and m2 share no player, so only the two orderings are in play. Two reports, two reflows:
    // the pair must not move, and the read over the rows must name the dependent.
    const seeded = await seed({ label: "k", entrants: 8 });
    const s1 = await placeMatch(seeded, { key: "k-s1", a: 0, b: 1, court: 1, at: iso(DAY1, "09:00") });
    const s2 = await placeMatch(seeded, { key: "k-s2", a: 6, b: 7, court: 1, at: iso(DAY1, "09:20") });
    const m1 = await placeMatch(seeded, { key: "k-m1", a: 4, b: 5, court: 1, at: iso(DAY1, "11:20") });
    const m2 = await placeMatch(seeded, {
      key: "k-m2",
      a: 2,
      b: 3,
      court: 1,
      at: iso(DAY1, "11:00"),
      prerequisites: [m1],
    });

    await reportAt(s1, iso(DAY1, "09:20"), seeded.tournamentId);
    await reportAt(s2, iso(DAY1, "09:40"), seeded.tournamentId);

    const times = await timesOf([m1, m2]);
    expect(times.get(m2)).toBe(iso(DAY1, "11:00"));
    expect(times.get(m1)).toBe(iso(DAY1, "11:20"));

    const conflicts = await fetchScheduleConflicts(seeded.tournamentId);
    const inverted = conflicts.filter((row) => row.match_id === m2);
    expect(inverted.map((row) => row.conflict_kind)).toContain("before_prerequisite");
  });
});
