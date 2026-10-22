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
 * The 30-point cap on a 21-point game, at the RPC rather than in the dialog.
 *
 * WHAT THIS PROVES
 *
 * `20261022000000_game_point_cap.sql` replaces three copies of the score predicate with one
 * pair of helpers. The client half is covered by `score-entry.test.ts` and
 * `tournament.test.ts`; what only a real Postgres can show is that the SQL half agrees, that
 * `report_placement_result` (and so the desk's live path) accepts 30-29, and that it refuses
 * a score above the cap instead of storing it.
 *
 * THE SCORES
 *
 * 30-29 is reachable: 29-29 is deuce and the next point ends the game. 31-29 is not - three
 * points clear of nothing, because the game stopped one point earlier. `211-19` is the
 * keystroke case: it used to be accepted, because the model only ever asked about a margin.
 *
 * LIMITS
 *
 * Runs against the LOCAL stack only (AGENTS.md): `npx supabase start`, then
 * `npm run integration:target -- local`.
 */

const TZ = "UTC";
const COURT_NUMBERS = [1, 2, 3];
/** A fixed day, so a fixture never depends on the wall clock. */
const DAY = "2099-02-04";

const iso = (time: string) => new Date(`${DAY}T${time}:00Z`).toISOString();

interface Seeded {
  tournamentId: string;
  entrants: string[];
  courtId: string;
}

const created: { tournaments: string[]; players: string[] } = { tournaments: [], players: [] };

let admin: TestIdentity;

beforeAll(async () => {
  admin = await createIdentity("admin", "score-cap");
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
 * One `in_progress` tournament with a single hand-placed round-one match.
 *
 * The default rule is the one that has a cap: placement is single game to 21, win by 2.
 */
async function seed(label: string): Promise<Seeded> {
  const days: DayFixture[] = [{ date: DAY, startTime: "00:00", endTime: "23:59", courts: COURT_NUMBERS }];
  const tournamentId = await createOwnedTournament(admin, {
    name: `itest-cap-${label}-${Date.now().toString(36)}`,
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
    players.push(await createPlayer({ name: `cap ${label} p${index}`, gender: "M" }));
  }
  created.players.push(...players);
  for (const playerId of players) {
    await createTeam({ categoryId: category.id, player1: playerId, player2: null });
  }

  await syncPlacementEntrants(category.id);
  await forceStatus(tournamentId, "in_progress");

  const entrants = (await fetchPlacementEntrants(tournamentId)).map((row) => row.id);
  const court = (await fetchCourts(tournamentId)).find((c) => c.number === 1);
  if (!court) throw new Error("the fixture tournament has no Court 1");

  const { data: match, error } = await serviceClient()
    .from("placement_matches")
    .insert({
      tournament_id: tournamentId,
      category_id: category.id,
      stage: "round1",
      generation_key: `${label}-1`,
      entrant_a_id: entrants[0] as string,
      entrant_b_id: entrants[1] as string,
      court_id: court.id,
      scheduled_time: iso("10:00"),
      status: "scheduled",
      prerequisite_ids: [],
    })
    .select("id")
    .single();
  if (error) throw new Error(`placing the match failed: ${error.message}`);

  return { tournamentId, entrants, courtId: court.id };
}

/** The match the seed placed, by its generation key. */
async function matchOf(tournamentId: string, label: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("placement_matches")
    .select("id")
    .eq("tournament_id", tournamentId)
    .eq("generation_key", `${label}-1`)
    .single();
  if (error) throw new Error(`reading the match failed: ${error.message}`);
  return data.id;
}

describe("the 30-point cap, at the RPC", () => {
  it("accepts 30-29, which is how a 21-point deuce ends", async () => {
    const seeded = await seed("accept");
    const match = await matchOf(seeded.tournamentId, "accept");

    // Placement is a single game, so one row is a complete result.
    const games = [{ a: 30, b: 29 }];
    await reportPlacementMatch(match, games, seeded.tournamentId);

    const { data, error } = await serviceClient()
      .from("placement_matches")
      .select("status, games")
      .eq("id", match)
      .single();
    if (error) throw new Error(error.message);
    expect(data.status).toBe("reported");
    expect(data.games).toEqual(games);
  }, 120_000);

  it("refuses a score above the cap, and says which cap", async () => {
    const seeded = await seed("over");
    const match = await matchOf(seeded.tournamentId, "over");

    // The keystroke case: 31-29 was a legal result until the cap existed.
    const { error } = await supabase.rpc("report_placement_result", {
      p_match_id: match,
      p_games: [{ a: 31, b: 29 }],
    });
    expect(error?.message).toBe("A game stops at 30 points");

    // Refused means untouched, not half-written.
    const { data } = await serviceClient()
      .from("placement_matches")
      .select("status, games")
      .eq("id", match)
      .single();
    expect(data?.status).toBe("scheduled");
    expect(data?.games).toEqual([]);
  }, 120_000);

  it("still refuses a game that is not won by two below the cap", async () => {
    const seeded = await seed("margin");
    const match = await matchOf(seeded.tournamentId, "margin");

    // The cap adds a way to win at 30; it does not raise the floor anywhere else.
    const { error } = await supabase.rpc("report_placement_result", {
      p_match_id: match,
      p_games: [{ a: 21, b: 20 }],
    });
    expect(error?.message).toBe("Games are to 21, win by 2");
  }, 120_000);

  it("refuses an absurd score that only clears the margin", async () => {
    const seeded = await seed("absurd");
    const match = await matchOf(seeded.tournamentId, "absurd");

    // 211-19 clears gamesTo and the margin, which is all the old predicate asked.
    const { error } = await supabase.rpc("report_placement_result", {
      p_match_id: match,
      p_games: [{ a: 211, b: 19 }],
    });
    expect(error?.message).toBe("A game stops at 30 points");
  }, 120_000);
});
