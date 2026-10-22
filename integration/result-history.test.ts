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
 * Correcting a result keeps what it replaced.
 *
 * WHAT THIS PROVES
 *
 * `20261022010000_match_result_history.sql` adds an AFTER UPDATE trigger on the four match
 * tables. Clearing a result was already loud and recoverable; correcting one silently
 * overwrote the row, so the previous score - and who sent it - was gone. These cases pin the
 * three things only a real Postgres can show: the trigger fires on a correction, it does not
 * fire on a first report, and an editor can read the history through RLS.
 *
 * LIMITS
 *
 * Runs against the LOCAL stack only (AGENTS.md): `npx supabase start`, then
 * `npm run integration:target -- local`.
 */

const TZ = "UTC";
const COURT_NUMBERS = [1, 2, 3];
const DAY = "2099-03-04";

interface Seeded {
  tournamentId: string;
  matchId: string;
}

const created: { tournaments: string[]; players: string[] } = { tournaments: [], players: [] };

let admin: TestIdentity;

beforeAll(async () => {
  admin = await createIdentity("admin", "result-history");
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

async function seed(label: string): Promise<Seeded> {
  const days: DayFixture[] = [
    { date: DAY, startTime: "00:00", endTime: "23:59", courts: COURT_NUMBERS },
  ];
  const tournamentId = await createOwnedTournament(admin, {
    name: `itest-history-${label}-${Date.now().toString(36)}`,
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
  for (let index = 0; index < 2; index += 1) {
    players.push(await createPlayer({ name: `history ${label} p${index}`, gender: "M" }));
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
      scheduled_time: new Date(`${DAY}T10:00:00Z`).toISOString(),
      status: "scheduled",
      prerequisite_ids: [],
    })
    .select("id")
    .single();
  if (error) throw new Error(`placing the match failed: ${error.message}`);

  return { tournamentId, matchId: match.id };
}

/** The history rows for a match, oldest first, read as the signed-in editor through RLS. */
async function historyOf(matchId: string) {
  const { data, error } = await supabase
    .from("match_result_history")
    .select("table_name, match_id, from_games, to_games, changed_by")
    .eq("match_id", matchId)
    .order("changed_at", { ascending: true });
  if (error) throw new Error(`reading the history failed: ${error.message}`);
  return data ?? [];
}

describe("correcting a reported result", () => {
  it("writes nothing for the first report, and keeps the replaced score for a correction", async () => {
    const seeded = await seed("correction");

    await reportPlacementMatch(seeded.matchId, [{ a: 21, b: 10 }], seeded.tournamentId);
    // An entry is not a correction: a history row here would make every result look amended.
    expect(await historyOf(seeded.matchId)).toEqual([]);

    await reportPlacementMatch(seeded.matchId, [{ a: 21, b: 15 }], seeded.tournamentId);

    const history = await historyOf(seeded.matchId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      table_name: "placement_matches",
      match_id: seeded.matchId,
      from_games: [{ a: 21, b: 10 }],
      to_games: [{ a: 21, b: 15 }],
    });
    // Who sent it is half the reason to keep the row.
    expect(history[0]?.changed_by).not.toBeNull();
  }, 120_000);

  it("appends one row per correction, in order", async () => {
    const seeded = await seed("twice");

    await reportPlacementMatch(seeded.matchId, [{ a: 21, b: 10 }], seeded.tournamentId);
    await reportPlacementMatch(seeded.matchId, [{ a: 21, b: 12 }], seeded.tournamentId);
    await reportPlacementMatch(seeded.matchId, [{ a: 21, b: 14 }], seeded.tournamentId);

    const history = await historyOf(seeded.matchId);
    expect(history.map((row) => row.to_games)).toEqual([
      [{ a: 21, b: 12 }],
      [{ a: 21, b: 14 }],
    ]);
    // The chain is continuous: each row starts where the last one ended.
    expect(history[0]?.from_games).toEqual([{ a: 21, b: 10 }]);
    expect(history[1]?.from_games).toEqual([{ a: 21, b: 12 }]);
  }, 120_000);

  it("is readable by an editor through RLS, and not writable", async () => {
    const seeded = await seed("rls");
    await reportPlacementMatch(seeded.matchId, [{ a: 21, b: 10 }], seeded.tournamentId);
    await reportPlacementMatch(seeded.matchId, [{ a: 21, b: 11 }], seeded.tournamentId);

    const { data } = await supabase
      .from("match_result_history")
      .select("id")
      .eq("match_id", seeded.matchId);
    expect(data).toHaveLength(1);

    // The trigger is the only writer; a client insert fails at the privilege layer.
    const write = await supabase.from("match_result_history").insert({
      table_name: "placement_matches",
      match_id: seeded.matchId,
    });
    expect(write.error).not.toBeNull();
  }, 120_000);
});
