import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import { createPlayer, createTeam } from "@/lib/tournament/actions";
import { fetchPlacementEntrants } from "@/lib/tournament/data";
import { syncPlacementEntrants } from "@/lib/tournament/placement-actions";

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
 * The guards `20261022030000_report_guards.sql` puts in front of a reported result.
 *
 * WHAT THIS PROVES
 *
 * Four refusals that only a real Postgres can show, because each lives inside the function
 * that writes the row rather than in front of it:
 *
 *   * a match whose second side is still "Winner of Quarterfinal 2" cannot take a score;
 *   * a void match is a decision, and a score does not overwrite it;
 *   * a correction sent from a stale read is refused, and the same correction from a fresh
 *     read is accepted;
 *   * a game entered after the match was already decided is refused **even when it repeats
 *     the last score** - the case the old value comparison missed;
 *   * a decimal is refused as a score rather than failing a cast.
 *
 * LIMITS
 *
 * Runs against the LOCAL stack only (AGENTS.md): `npx supabase start`, then
 * `npm run integration:target -- local`.
 */

const TZ = "UTC";
const COURT_NUMBERS = [1, 2];
/** A fixed day, so a fixture never depends on the wall clock. */
const DAY = "2099-02-05";

const iso = (time: string) => new Date(`${DAY}T${time}:00Z`).toISOString();

interface Seeded {
  tournamentId: string;
  categoryId: string;
  entrants: string[];
  teams: string[];
  courtId: string;
}

const created: { tournaments: string[]; players: string[] } = { tournaments: [], players: [] };

let admin: TestIdentity;

beforeAll(async () => {
  admin = await createIdentity("admin", "report-guards");
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

/** An in-progress tournament with four registered entrants, enough for any bracket. */
async function seed(label: string): Promise<Seeded> {
  const days: DayFixture[] = [
    { date: DAY, startTime: "00:00", endTime: "23:59", courts: COURT_NUMBERS },
  ];
  const tournamentId = await createOwnedTournament(admin, {
    name: `itest-guards-${label}-${Date.now().toString(36)}`,
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
  for (let index = 0; index < 4; index += 1) {
    players.push(await createPlayer({ name: `guard ${label} p${index}`, gender: "M" }));
  }
  created.players.push(...players);

  const teams: string[] = [];
  for (const playerId of players) {
    const team = await createTeam({ categoryId: category.id, player1: playerId, player2: null });
    teams.push(team.id);
  }

  await syncPlacementEntrants(category.id);
  await forceStatus(tournamentId, "in_progress");

  const entrants = (await fetchPlacementEntrants(tournamentId)).map((row) => row.id);
  const { data: court, error: courtError } = await serviceClient()
    .from("courts")
    .select("id")
    .eq("tournament_id", tournamentId)
    .eq("number", 1)
    .single();
  if (courtError) throw new Error(`reading the court failed: ${courtError.message}`);

  return { tournamentId, categoryId: category.id, entrants, teams, courtId: court.id };
}

/** A placement match with both entrants, which is the state the desk can score. */
async function placementMatch(
  seeded: Seeded,
  label: string,
  status = "scheduled",
): Promise<string> {
  const { data, error } = await serviceClient()
    .from("placement_matches")
    .insert({
      tournament_id: seeded.tournamentId,
      category_id: seeded.categoryId,
      stage: "round1",
      generation_key: `${label}-1`,
      entrant_a_id: seeded.entrants[0] as string,
      entrant_b_id: seeded.entrants[1] as string,
      court_id: seeded.courtId,
      scheduled_time: iso("10:00"),
      status,
      prerequisite_ids: [],
    })
    .select("id")
    .single();
  if (error) throw new Error(`placing the match failed: ${error.message}`);
  return data.id;
}

/**
 * A round-one knockout match with only side A decided.
 *
 * This is the shape a bracket has before its feeders are played - the desk draws it as
 * "Winner of Quarterfinal 2" - and the case the old reporter let through, because it only
 * asked whether the *winning* side had a name.
 */
async function halfDrawnTierMatch(seeded: Seeded, label: string): Promise<string> {
  const { data: draw, error: drawError } = await serviceClient()
    .from("tier_draws")
    .insert({
      tournament_id: seeded.tournamentId,
      category_id: seeded.categoryId,
      tier: "A",
      bracket_size: 2,
      entrant_count: 2,
    })
    .select("id")
    .single();
  if (drawError) throw new Error(`creating the draw failed: ${drawError.message}`);

  const { data, error } = await serviceClient()
    .from("tier_draw_matches")
    .insert({
      tournament_id: seeded.tournamentId,
      draw_id: draw.id,
      round: 1,
      slot: 1,
      entrant_a_id: seeded.entrants[0] as string,
      entrant_b_id: null,
      court_id: seeded.courtId,
      scheduled_time: iso("11:00"),
      status: "scheduled",
    })
    .select("id")
    .single();
  if (error) throw new Error(`placing the knockout match failed: ${error.message}`);
  return data.id;
}

/** One legacy A/B/C/D draw match, both teams known. */
async function drawMatch(seeded: Seeded, label: string): Promise<string> {
  const { data: draw, error: drawError } = await serviceClient()
    .from("draws")
    .insert({
      tournament_id: seeded.tournamentId,
      category_id: seeded.categoryId,
      tier: "B",
      bracket_size: 2,
      entrant_count: 2,
    })
    .select("id")
    .single();
  if (drawError) throw new Error(`creating the legacy draw failed: ${drawError.message}`);

  const { data, error } = await serviceClient()
    .from("draw_matches")
    .insert({
      draw_id: draw.id,
      tournament_id: seeded.tournamentId,
      round: 1,
      slot: 1,
      team_a_id: seeded.teams[0] as string,
      team_b_id: seeded.teams[1] as string,
      court_id: seeded.courtId,
      scheduled_time: iso("12:00"),
      status: "scheduled",
    })
    .select("id")
    .single();
  if (error) throw new Error(`placing the draw match failed: ${error.message}`);
  return data.id;
}

const reportPlacement = (matchId: string, games: unknown, extra: Record<string, unknown> = {}) =>
  supabase.rpc("report_placement_result", {
    p_match_id: matchId,
    p_games: games,
    ...extra,
  } as never);

describe("a result needs two decided sides", () => {
  it("refuses a knockout match still waiting for one of its sides", async () => {
    const seeded = await seed("half");
    const match = await halfDrawnTierMatch(seeded, "half");

    const { error } = await supabase.rpc("report_tier_draw_result", {
      p_match_id: match,
      p_games: [{ a: 21, b: 10 }],
    } as never);

    expect(error?.message).toBe(
      "This match is still waiting for one of its sides, so it has no score yet",
    );

    // Refused means untouched, not half-written.
    const { data } = await serviceClient()
      .from("tier_draw_matches")
      .select("status, games")
      .eq("id", match)
      .single();
    expect(data?.status).toBe("scheduled");
    expect(data?.games).toEqual([]);
  }, 120_000);
});

describe("a decision is not a result", () => {
  it("refuses a score against a void match, and says which state it is in", async () => {
    const seeded = await seed("void");
    const match = await placementMatch(seeded, "void", "void");

    const { error } = await reportPlacement(match, [{ a: 21, b: 10 }]);

    expect(error?.message).toBe('This match is marked "void" and takes no score');

    const { data } = await serviceClient()
      .from("placement_matches")
      .select("status")
      .eq("id", match)
      .single();
    expect(data?.status).toBe("void");
  }, 120_000);

  it("refuses a score against a walkover too", async () => {
    const seeded = await seed("walkover");
    const match = await placementMatch(seeded, "walkover", "walkover");

    const { error } = await reportPlacement(match, [{ a: 21, b: 10 }]);
    expect(error?.message).toBe('This match is marked "walkover" and takes no score');
  }, 120_000);
});

describe("a result belongs to the read it was entered from", () => {
  it("refuses a correction sent from a stale read, and takes the current one", async () => {
    const seeded = await seed("stale");
    const match = await placementMatch(seeded, "stale");

    // A first entry: the dialog opened on `scheduled`, so that is what it expects.
    const first = await reportPlacement(match, [{ a: 21, b: 10 }], {
      p_expected_status: "scheduled",
    });
    expect(first.error).toBeNull();

    const { data: row, error: readError } = await serviceClient()
      .from("placement_matches")
      .select("reported_time")
      .eq("id", match)
      .single();
    if (readError) throw new Error(readError.message);
    const token = row.reported_time as string;

    // Another desk corrects it first. `status` stays `reported`, so only the token can tell
    // this dialog that its snapshot is out of date.
    const second = await reportPlacement(match, [{ a: 21, b: 12 }], {
      p_expected_status: "reported",
      p_expected_reported_at: token,
    });
    expect(second.error).toBeNull();

    // The first dialog saves now, still holding the token it opened with.
    const stale = await reportPlacement(match, [{ a: 21, b: 14 }], {
      p_expected_status: "reported",
      p_expected_reported_at: token,
    });
    expect(stale.error?.message).toBe(
      "This result was changed while you were entering it. Close this window and reopen the match to see the latest.",
    );

    // The other desk's result survives: a refused correction writes nothing.
    const { data: kept } = await serviceClient()
      .from("placement_matches")
      .select("games")
      .eq("id", match)
      .single();
    expect(kept?.games).toEqual([{ a: 21, b: 12 }]);
  }, 120_000);

  it("refuses a save whose match moved on, even for a first entry", async () => {
    const seeded = await seed("moved");
    const match = await placementMatch(seeded, "moved");

    // Someone started the match while the dialog was open.
    await serviceClient()
      .from("placement_matches")
      .update({ status: "in-progress" })
      .eq("id", match);

    const { error } = await reportPlacement(match, [{ a: 21, b: 10 }], {
      p_expected_status: "scheduled",
    });
    expect(error?.message).toBe(
      'This match changed to "in-progress" while you were entering the result. Close this window and reopen the match to see the latest.',
    );
  }, 120_000);
});

describe("the legacy draw's decided check counts rather than compares", () => {
  it("refuses a third game even when it repeats the last score", async () => {
    const seeded = await seed("repeat");
    const match = await drawMatch(seeded, "repeat");

    // Two 21-19 games have decided a best of three. The third repeats the score, which is
    // exactly the case `game <> p_games -> -1` could not see: the row equals the last one,
    // so the comparison was false and the extra game was stored.
    const { error } = await supabase.rpc("report_draw_result", {
      p_match_id: match,
      p_games: [
        { a: 21, b: 19 },
        { a: 21, b: 19 },
        { a: 21, b: 19 },
      ],
    } as never);

    expect(error?.message).toBe("Do not enter games after the match is decided");

    const { data } = await serviceClient()
      .from("draw_matches")
      .select("status, games")
      .eq("id", match)
      .single();
    expect(data?.status).toBe("scheduled");
    expect(data?.games).toEqual([]);
  }, 120_000);

  it("accepts the same repeat when it is inside the best of", async () => {
    const seeded = await seed("repeat-ok");
    const match = await drawMatch(seeded, "repeat-ok");

    // Three identical games are legal in a best of five: nothing was decided early.
    await serviceClient()
      .from("tournaments")
      .update({ knockout_best_of: 5 })
      .eq("id", seeded.tournamentId);

    const { error } = await supabase.rpc("report_draw_result", {
      p_match_id: match,
      p_games: [
        { a: 21, b: 19 },
        { a: 21, b: 19 },
        { a: 21, b: 0 },
      ],
    } as never);
    expect(error).toBeNull();
  }, 120_000);
});

describe("a game is a whole number of points", () => {
  it("says so instead of failing the cast", async () => {
    const seeded = await seed("decimal");
    const match = await placementMatch(seeded, "decimal");

    const { error } = await reportPlacement(match, [{ a: 21.5, b: 19 }]);
    expect(error?.message).toBe("Each game needs a whole number of points");
  }, 120_000);

  it("refuses a negative score in words, rather than on the integer range", async () => {
    const seeded = await seed("negative");
    const match = await placementMatch(seeded, "negative");

    // The low end of `int` is the case a single upper bound leaves to the cast:
    // -99999999999 matches the digits pattern and then overflows `::int`.
    const { error } = await reportPlacement(match, [{ a: -99999999999, b: 19 }]);
    expect(error?.message).toBe("Each game needs a valid winning score");
  }, 120_000);

  it("refuses a score beyond what the column holds", async () => {
    const seeded = await seed("huge");
    const match = await placementMatch(seeded, "huge");

    const { error } = await reportPlacement(match, [{ a: 4000000000, b: 19 }]);
    expect(error?.message).toBe("A game score is too large to record");
  }, 120_000);
});
