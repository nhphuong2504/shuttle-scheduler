import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import { createPlayer, createTeam } from "@/lib/tournament/actions";
import { fetchCourts, fetchPlacementEntrants } from "@/lib/tournament/data";
import { reportPlacementMatch, syncPlacementEntrants } from "@/lib/tournament/placement-actions";

import {
  createIdentity,
  createOwnedTournament,
  destroyIdentity,
  destroyTournaments,
  forceStatus,
  serviceClient,
  type DayFixture,
  type TestIdentity,
} from "./env";

/**
 * Reporting a result late: `p_ended_minutes_ago` on the two current-format report RPCs.
 *
 * WHAT THIS PROVES
 *
 * `20261011000000_report_ended_minutes_ago.sql` adds an optional integer offset to
 * `report_placement_result` and `report_tier_draw_result`. The reflow reads `ended_at`,
 * so a result entered fifteen minutes after the match actually finished used to be
 * recorded as a fifteen-minute overrun and pushed the rest of the court back. The
 * cases below pin three things a hermetic test cannot see: the resolved instant is
 * server-side arithmetic, the zero default keeps the old `COALESCE(ended_at, now())`
 * exactly, and the reflow reads the backdated instant rather than the entry time.
 *
 * THE VIRTUAL CLOCK, AND WHY THE FINISH IS PLACED INSIDE ONE DAY
 *
 * `statement_timestamp()` is the real server clock and cannot be moved, so this is the
 * one place a correct test has to be relative to it. The reflow scopes its cascade to
 * the source's published day and holds anything it would push past that day's close, so
 * `pickMinutesAgo` backs the offset up until `now - N` sits comfortably inside one UTC
 * day: the source and its successor then share that day and the moved successor still
 * finishes before the close. The safe window is nineteen hours a day and the reachable
 * window is twelve, so a value always exists and N stays well inside the 720 ceiling.
 *
 * Where the instant itself is under test (the zero default, the preserved fixture) the
 * day does not matter and a fixed date is used, the way `live-reflow.test.ts` dates its
 * own fixtures.
 *
 * LIMITS
 *
 * Runs against the LOCAL stack only (AGENTS.md): `npx supabase start`, then
 * `npm run integration:target -- local`. It needs a container runtime, so it does not
 * run in the editor by default - `npm run test:integration`.
 */

const TZ = "UTC";
const COURT_NUMBERS = [1, 2, 3];
/** A fixed day for the cases that do not depend on the server clock. */
const FIXED_DAY = "2099-01-04";
/** The win that `placement_check_games` accepts for the default rules. */
const GAMES = [{ a: 21, b: 10 }];

/** A scripted wall time on a day, in the form the read-back produces. */
const iso = (day: string, time: string) => new Date(`${day}T${time}:00Z`).toISOString();

/** Today in UTC, for the cases that need a day the real clock is inside. */
const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * The most recent instant that is at least zero and at most 720 minutes ago and sits
 * inside [02:00, 21:00) UTC.
 *
 * Backing up from `now` finds the smallest offset that works. The reachable window is
 * twelve hours and the safe window is nineteen hours a day, so the two always intersect
 * and the loop always returns; the offset is a few hours, never the ceiling.
 */
function pickMinutesAgo(): number {
  for (let minutes = 0; minutes <= 720; minutes += 1) {
    const hour = new Date(Date.now() - minutes * 60_000).getUTCHours();
    if (hour >= 2 && hour < 21) return minutes;
  }
  throw new Error("no safe finish instant within the offset ceiling");
}

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
  admin = await createIdentity("admin", "ended-ago");
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
 * An `in_progress` tournament on one day, with hand-placed matches.
 *
 * Configuring a tournament - days, teams, entrants - is only allowed while it is
 * `upcoming`, so `forceStatus` performs the move past the first-match gate after the
 * fixture is built. That is the transition `start-match-checks.test.ts` relies on; this
 * suite reports matches without starting them, so it needs the state directly.
 */
async function seed(options: { label: string; entrants: number; day: string }): Promise<Seeded> {
  const days: DayFixture[] = [
    { date: options.day, startTime: "00:00", endTime: "23:59", courts: COURT_NUMBERS },
  ];

  const tournamentId = await createOwnedTournament(admin, {
    name: `itest-ago-${options.label}-${Date.now().toString(36)}`,
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

  const players: string[] = [];
  for (let index = 0; index < options.entrants; index += 1) {
    players.push(await createPlayer({ name: `ago ${options.label} p${index}`, gender: "M" }));
  }
  created.players.push(...players);
  for (const playerId of players) {
    await createTeam({ categoryId: category.id, player1: playerId, player2: null });
  }
  await syncPlacementEntrants(category.id);

  await forceStatus(tournamentId, "in_progress");

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

/** Writes a virtual window on a row, a fixture and never an assertion. */
async function setWindow(
  matchId: string,
  window: { started_at?: string; ended_at?: string },
): Promise<void> {
  const { error } = await serviceClient()
    .from("placement_matches")
    .update(window)
    .eq("id", matchId);
  if (error) throw new Error(`setting the window failed: ${error.message}`);
}

/** One match's row, for the assertions about the finish and the reflow. */
async function rowOf(id: string) {
  const { data, error } = await serviceClient()
    .from("placement_matches")
    .select("status, scheduled_time, started_at, ended_at")
    .eq("id", id)
    .single();
  if (error) throw new Error(`reading ${id} failed: ${error.message}`);
  return data;
}

describe("reporting a result that finished N minutes ago", () => {
  it("(i) keeps the old behaviour at the default: the finish is the entry time", async () => {
    // The parameter is optional and defaults to 0, which must mean exactly what the RPC
    // did before: COALESCE(ended_at, now()). A caller that does not pass it - the desk
    // reporting live, an older client - therefore behaves as it always did.
    const seeded = await seed({ label: "i", entrants: 4, day: todayUtc() });
    const match = await placeMatch(seeded, {
      key: "i-1",
      a: 0,
      b: 1,
      court: 1,
      at: iso(todayUtc(), "10:00"),
    });

    const before = Date.now();
    await reportPlacementMatch(match, GAMES, seeded.tournamentId);
    const after = Date.now();

    const row = await rowOf(match);
    expect(row.status).toBe("reported");
    const ended = Date.parse(row.ended_at as string);
    expect(ended).toBeGreaterThanOrEqual(before - 2_000);
    expect(ended).toBeLessThanOrEqual(after + 2_000);
  }, 120_000);

  it("(v) preserves a fixture's virtual ended_at when the offset is 0", async () => {
    // The other half of the default: the report must not overwrite an ended_at it was
    // handed. Every reflow suite pre-writes a virtual finish (service role) and reports
    // against it, so an explicit zero that replaced it with now() would break them all.
    const seeded = await seed({ label: "v", entrants: 4, day: FIXED_DAY });
    const match = await placeMatch(seeded, {
      key: "v-1",
      a: 0,
      b: 1,
      court: 1,
      at: iso(FIXED_DAY, "10:00"),
    });
    const virtualEnded = iso(FIXED_DAY, "10:30");
    await setWindow(match, { started_at: iso(FIXED_DAY, "10:00"), ended_at: virtualEnded });

    await reportPlacementMatch(match, GAMES, seeded.tournamentId, 0);

    const row = await rowOf(match);
    expect(new Date(row.ended_at as string).toISOString()).toBe(virtualEnded);
  }, 120_000);

  it("(iii) refuses a negative offset and one past the ceiling", async () => {
    // No absolute time is accepted, so a future finish is only reachable through a
    // negative offset: refused, like the typo past the twelve-hour ceiling. The match is
    // left untouched by both, which is what a rolled-back RPC means.
    const seeded = await seed({ label: "iii", entrants: 4, day: todayUtc() });
    const match = await placeMatch(seeded, {
      key: "iii-1",
      a: 0,
      b: 1,
      court: 1,
      at: iso(todayUtc(), "10:00"),
    });

    await expect(reportPlacementMatch(match, GAMES, seeded.tournamentId, -5)).rejects.toThrow(
      /cannot be in the future/i,
    );
    await expect(reportPlacementMatch(match, GAMES, seeded.tournamentId, 721)).rejects.toThrow(
      /more than 720 minutes/i,
    );

    expect((await rowOf(match)).status).toBe("scheduled");

    // The ceiling itself is inclusive: 720 is accepted, and lands twelve hours back.
    await reportPlacementMatch(match, GAMES, seeded.tournamentId, 720);
    const ended = Date.parse((await rowOf(match)).ended_at as string);
    expect(Math.abs(ended - (Date.now() - 720 * 60_000))).toBeLessThan(120_000);
  }, 120_000);

  it("(iv) refuses a finish earlier than the match's own start", async () => {
    // A backdated finish is still bounded by the row: a match cannot have ended before
    // it began, and a negative span would feed the reflow a negative duration. The
    // virtual start is in the future of the resolved finish, so the check fires.
    const seeded = await seed({ label: "iv", entrants: 4, day: FIXED_DAY });
    const match = await placeMatch(seeded, {
      key: "iv-1",
      a: 0,
      b: 1,
      court: 1,
      at: iso(FIXED_DAY, "10:00"),
    });
    await setWindow(match, { started_at: iso(FIXED_DAY, "10:00") });

    await expect(reportPlacementMatch(match, GAMES, seeded.tournamentId, 15)).rejects.toThrow(
      /before the match started/i,
    );
    expect((await rowOf(match)).status).toBe("scheduled");
  }, 120_000);

  it("(ii) backdates the finish and the reflow reads the backdated instant", async () => {
    // The case the migration exists for. The source is reported with the offset and its
    // successor is published ten minutes before the true finish, so the reflow has to
    // push it to the source's real end. If the RPC had stamped now() instead, the
    // successor would be pushed all the way to the entry time; asserting it lands on the
    // source's own ended_at is what proves the offset reached the reflow.
    const minutesAgo = pickMinutesAgo();
    const finishedAt = new Date(Date.now() - minutesAgo * 60_000);
    const day = finishedAt.toISOString().slice(0, 10);
    const sourceAt = new Date(finishedAt.getTime() - 30 * 60_000);
    const successorAt = new Date(finishedAt.getTime() - 10 * 60_000);

    const seeded = await seed({ label: "ii", entrants: 4, day });
    const source = await placeMatch(seeded, {
      key: "ii-1",
      a: 0,
      b: 1,
      court: 1,
      at: sourceAt.toISOString(),
    });
    const successor = await placeMatch(seeded, {
      key: "ii-2",
      a: 2,
      b: 3,
      court: 1,
      at: successorAt.toISOString(),
    });
    // The start has to precede the finish or the new check refuses the report, and the
    // reflow reads its span from the two columns.
    await setWindow(source, { started_at: sourceAt.toISOString() });

    await reportPlacementMatch(source, GAMES, seeded.tournamentId, minutesAgo);

    const sourceRow = await rowOf(source);
    const successorRow = await rowOf(successor);

    // The finish is the backdated instant, measured on the server's clock.
    const ended = Date.parse(sourceRow.ended_at as string);
    expect(Math.abs(ended - finishedAt.getTime())).toBeLessThan(120_000);
    // And it is unambiguously earlier than the entry time, so a now()-stamped finish
    // would fail the next assertion.
    expect(ended).toBeLessThan(Date.now() - (minutesAgo - 2) * 60_000);

    // The reflow moved the successor to exactly the source's real end, not to now().
    expect(new Date(successorRow.scheduled_time as string).toISOString()).toBe(
      new Date(sourceRow.ended_at as string).toISOString(),
    );
    expect(Date.parse(successorRow.scheduled_time as string)).toBeGreaterThan(
      successorAt.getTime(),
    );
  }, 120_000);
});
