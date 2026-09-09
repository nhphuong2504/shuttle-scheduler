import { supabase } from "@/integrations/supabase/client";

import type { Team, Pool, PoolEntry, PoolMatch, DrawMatch, Settings, Court } from "./data";
import { buildFirstRound, tierForRank, type DrawTier, type Entrant } from "./draws";
import { gamesWinner, type GameScore } from "./format";
import { circleMethod, splitIntoPools } from "./pools";
import { scheduleMatches, type SchedulableMatch } from "./scheduler";
import { computeStandings, poolIsComplete } from "./standings";

async function ok<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  if (data == null) throw new Error("The record could not be found.");
  return data;
}

/* ---------------------------------- registration --------------------------------- */

export async function createPlayer(input: { name: string; email?: string; phone?: string; gender?: string }) {
  return ok(
    supabase
      .from("players")
      .insert({
        name: input.name.trim(),
        email: input.email?.trim() || null,
        phone: input.phone?.trim() || null,
        gender: input.gender || null,
      })
      .select("*")
      .single(),
  );
}

export async function createTeam(input: { categoryId: string; player1: string; player2: string | null }) {
  return ok(
    supabase
      .from("teams")
      .insert({
        category_id: input.categoryId,
        player_1_id: input.player1,
        player_2_id: input.player2,
      })
      .select("*")
      .single(),
  );
}

export async function deleteTeam(id: string) {
  const { error } = await supabase.from("teams").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function setTeamWithdrawn(id: string, withdrawn: boolean) {
  const { error } = await supabase.from("teams").update({ withdrawn }).eq("id", id);
  if (error) throw new Error(error.message);
}

/* ------------------------------------- pools ------------------------------------- */

export async function clearPoolsForCategory(categoryId: string) {
  const pools = await ok(supabase.from("pools").select("id").eq("category_id", categoryId));
  const ids = (pools ?? []).map((p) => p.id);
  if (!ids.length) return;
  const del = async (table: "pool_matches" | "pool_entries") => {
    const { error } = await supabase.from(table).delete().in("pool_id", ids);
    if (error) throw new Error(error.message);
  };
  await del("pool_matches");
  await del("pool_entries");
  const { error } = await supabase.from("pools").delete().in("id", ids);
  if (error) throw new Error(error.message);
}

export async function generatePoolsForCategory(categoryId: string, teams: Team[]) {
  const active = teams.filter((t) => !t.withdrawn);
  if (active.length < 4) throw new Error("A category needs at least 4 entries to form pools.");
  await clearPoolsForCategory(categoryId);

  const groups = splitIntoPools(active);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i] ?? [];
    if (!group.length) continue;
    const pool = await ok(
      supabase
        .from("pools")
        .insert({ category_id: categoryId, name: `Pool ${String.fromCharCode(65 + i)}`, size: group.length })
        .select("id")
        .single(),
    );
    const { error: entryError } = await supabase
      .from("pool_entries")
      .insert(group.map((t, idx) => ({ pool_id: pool.id, team_id: t.id, position: idx + 1 })));
    if (entryError) throw new Error(entryError.message);

    const pairings = circleMethod(group);
    const { error: matchError } = await supabase.from("pool_matches").insert(
      pairings.map((p) => ({
        pool_id: pool.id,
        category_id: categoryId,
        round: p.round,
        team_a_id: p.teamA.id,
        team_b_id: p.teamB.id,
      })),
    );
    if (matchError) throw new Error(matchError.message);
  }
}

export async function reportPoolMatch(matchId: string, scoreA: number, scoreB: number) {
  const match = await ok(supabase.from("pool_matches").select("*").eq("id", matchId).single());
  const winner = scoreA === scoreB ? null : scoreA > scoreB ? match.team_a_id : match.team_b_id;
  if (!winner) throw new Error("A group match cannot end level — enter a winning score.");
  const { error } = await supabase
    .from("pool_matches")
    .update({
      score_a: scoreA,
      score_b: scoreB,
      winner_id: winner,
      status: "reported",
      reported_time: new Date().toISOString(),
    })
    .eq("id", matchId);
  if (error) throw new Error(error.message);
}

export async function startMatch(table: "pool_matches" | "draw_matches", matchId: string, courtId: string | null) {
  const { error } = await supabase
    .from(table)
    .update({ status: "in_progress", started_at: new Date().toISOString(), court_id: courtId })
    .eq("id", matchId);
  if (error) throw new Error(error.message);
}

export async function resetMatch(table: "pool_matches" | "draw_matches", matchId: string) {
  const base = { status: "scheduled", winner_id: null, reported_time: null, started_at: null };
  const { error } =
    table === "pool_matches"
      ? await supabase
          .from("pool_matches")
          .update({ ...base, score_a: null, score_b: null })
          .eq("id", matchId)
      : await supabase
          .from("draw_matches")
          .update({ ...base, games: [] })
          .eq("id", matchId);
  if (error) throw new Error(error.message);
}

export async function setMatchNote(table: "pool_matches" | "draw_matches", matchId: string, note: string) {
  const { error } = await supabase.from(table).update({ note: note || null }).eq("id", matchId);
  if (error) throw new Error(error.message);
}

export async function setManualRankOverride(entryId: string, rank: number | null) {
  const { error } = await supabase.from("pool_entries").update({ manual_rank_override: rank }).eq("id", entryId);
  if (error) throw new Error(error.message);
}

/* ------------------------------------- draws ------------------------------------- */

export interface DrawGate {
  ready: boolean;
  waitingOn: string[];
}

export function drawGate(pools: Pool[], matches: PoolMatch[]): DrawGate {
  const waitingOn: string[] = [];
  for (const pool of pools) {
    const poolMatches = matches.filter((m) => m.pool_id === pool.id);
    if (!poolIsComplete(poolMatches)) waitingOn.push(pool.name);
  }
  return { ready: pools.length > 0 && waitingOn.length === 0, waitingOn };
}

export function entrantsByTier(
  pools: Pool[],
  entries: PoolEntry[],
  matches: PoolMatch[],
): Record<DrawTier, Entrant[]> {
  const byTier: Record<DrawTier, Entrant[]> = { A: [], B: [], C: [], D: [] };
  for (const pool of pools) {
    const poolEntries = entries.filter((e) => e.pool_id === pool.id);
    const overrides: Record<string, number | null> = {};
    for (const e of poolEntries) overrides[e.team_id] = e.manual_rank_override;
    const standings = computeStandings(
      poolEntries.map((e) => e.team_id),
      matches.filter((m) => m.pool_id === pool.id),
      overrides,
    );
    for (const s of standings) {
      byTier[tierForRank(s.rank)].push({
        teamId: s.teamId,
        diff: s.diff,
        wins: s.wins,
        poolName: pool.name,
        poolRank: s.rank,
      });
    }
  }
  return byTier;
}

export async function clearDrawsForCategory(categoryId: string) {
  const draws = await ok(supabase.from("draws").select("id").eq("category_id", categoryId));
  const ids = (draws ?? []).map((d) => d.id);
  if (!ids.length) return;
  const { error: matchError } = await supabase.from("draw_matches").delete().in("draw_id", ids);
  if (matchError) throw new Error(matchError.message);
  const { error } = await supabase.from("draws").delete().in("id", ids);
  if (error) throw new Error(error.message);
}

export async function generateDrawsForCategory(
  categoryId: string,
  pools: Pool[],
  entries: PoolEntry[],
  matches: PoolMatch[],
) {
  const gate = drawGate(pools, matches);
  if (!gate.ready) throw new Error(`Waiting on results from ${gate.waitingOn.join(", ") || "the pools"}.`);

  await clearDrawsForCategory(categoryId);
  const tiers = entrantsByTier(pools, entries, matches);

  for (const tier of ["A", "B", "C", "D"] as DrawTier[]) {
    const entrants = tiers[tier];
    if (entrants.length < 2) continue;
    const { bracketSize, pairs } = buildFirstRound(entrants);
    const draw = await ok(
      supabase
        .from("draws")
        .insert({ category_id: categoryId, tier, bracket_size: bracketSize, entrant_count: entrants.length })
        .select("id")
        .single(),
    );
    const rows = pairs.map((p) => ({
      draw_id: draw.id,
      round: 1,
      slot: p.slot,
      team_a_id: p.teamA,
      team_b_id: p.teamB,
      winner_id: p.isBye ? (p.teamA ?? p.teamB) : null,
      status: p.isBye ? "reported" : "scheduled",
      note: p.isBye ? "Bye" : null,
    }));
    const { error } = await supabase.from("draw_matches").insert(rows);
    if (error) throw new Error(error.message);
    await advanceDraw(draw.id);
  }
}

/** Creates the next round only when the current round is fully decided. */
export async function advanceDraw(drawId: string) {
  const all = await ok(supabase.from("draw_matches").select("*").eq("draw_id", drawId));
  const rounds = (all ?? []) as DrawMatch[];
  if (!rounds.length) return;
  const maxRound = Math.max(...rounds.map((m) => m.round));
  const current = rounds.filter((m) => m.round === maxRound).sort((a, b) => a.slot - b.slot);
  if (current.length < 2) return;
  if (!current.every((m) => m.winner_id)) return;

  const next: {
    draw_id: string;
    round: number;
    slot: number;
    team_a_id: string | null;
    team_b_id: string | null;
  }[] = [];
  for (let i = 0; i < current.length; i += 2) {
    next.push({
      draw_id: drawId,
      round: maxRound + 1,
      slot: i / 2 + 1,
      team_a_id: current[i]?.winner_id ?? null,
      team_b_id: current[i + 1]?.winner_id ?? null,
    });
  }
  const { error } = await supabase.from("draw_matches").insert(next);
  if (error) throw new Error(error.message);
}

export async function reportDrawMatch(matchId: string, games: GameScore[]) {
  const match = await ok(supabase.from("draw_matches").select("*").eq("id", matchId).single());
  const side = gamesWinner(games);
  if (!side) throw new Error("Enter game scores until one side has won the match.");
  const winner = side === "a" ? match.team_a_id : match.team_b_id;
  if (!winner) throw new Error("That side has no team assigned yet.");
  const { error } = await supabase
    .from("draw_matches")
    .update({
      games: games.map((g) => ({ a: g.a, b: g.b })),
      winner_id: winner,
      status: "reported",
      reported_time: new Date().toISOString(),
    })
    .eq("id", matchId);
  if (error) throw new Error(error.message);
  await advanceDraw(match.draw_id);
}

/* ----------------------------------- scheduling ---------------------------------- */

function dayStartEnd(settings: Settings, day: 1 | 2) {
  const date = day === 1 ? settings.day_1 : settings.day_2;
  return {
    start: new Date(`${date}T${settings.day_start_time}`),
    end: new Date(`${date}T${settings.day_end_time}`),
  };
}

export interface ScheduleSummary {
  placed: number;
  unscheduled: number;
  utilization: number;
  overrun: boolean;
}

export async function scheduleDay(
  day: 1 | 2,
  settings: Settings,
  courts: Court[],
  teams: Team[],
  poolMatches: PoolMatch[],
  drawMatches: DrawMatch[],
  drawCategory: Map<string, string>,
): Promise<ScheduleSummary> {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const playersOf = (a: string | null, b: string | null) => {
    const ids: string[] = [];
    for (const id of [a, b]) {
      const team = id ? teamById.get(id) : undefined;
      if (!team) continue;
      ids.push(team.player_1_id);
      if (team.player_2_id) ids.push(team.player_2_id);
    }
    return ids;
  };

  const items: SchedulableMatch[] =
    day === 1
      ? poolMatches.map((m) => ({
          id: m.id,
          categoryId: m.category_id,
          playerIds: playersOf(m.team_a_id, m.team_b_id),
          kind: "group" as const,
          order: m.round,
        }))
      : drawMatches
          .filter((m) => m.team_a_id && m.team_b_id && m.status !== "reported")
          .map((m) => ({
            id: m.id,
            categoryId: drawCategory.get(m.draw_id) ?? m.draw_id,
            playerIds: playersOf(m.team_a_id, m.team_b_id),
            kind: "knockout" as const,
            order: m.round * 100 + m.slot,
          }));

  const { start, end } = dayStartEnd(settings, day);
  const result = scheduleMatches(items, {
    dayStart: start,
    dayEnd: end,
    courtCount: settings.court_count,
    slotMinutes: day === 1 ? settings.group_slot_minutes : settings.knockout_slot_minutes,
    restGapMinutes: settings.rest_gap_minutes,
  });

  const courtByNumber = new Map(courts.map((c) => [c.number, c.id]));
  const table = day === 1 ? "pool_matches" : "draw_matches";
  for (const slot of result.slots) {
    const { error } = await supabase
      .from(table)
      .update({
        scheduled_time: slot.start.toISOString(),
        court_id: courtByNumber.get(slot.courtNumber) ?? null,
      })
      .eq("id", slot.matchId);
    if (error) throw new Error(error.message);
  }

  if (day === 1) {
    // pool scheduled_end drives the late-reporting alert
    const endByPool = new Map<string, number>();
    for (const slot of result.slots) {
      const match = poolMatches.find((m) => m.id === slot.matchId);
      if (!match) continue;
      const prev = endByPool.get(match.pool_id) ?? 0;
      endByPool.set(match.pool_id, Math.max(prev, slot.end.getTime()));
    }
    for (const [poolId, endedAt] of endByPool) {
      const { error } = await supabase
        .from("pools")
        .update({ scheduled_end: new Date(endedAt).toISOString() })
        .eq("id", poolId);
      if (error) throw new Error(error.message);
    }
  }

  return {
    placed: result.slots.length,
    unscheduled: result.unscheduled.length,
    utilization: result.utilization,
    overrun: result.overrun,
  };
}

export async function updateSettings(id: string, patch: Partial<Settings>) {
  const { error } = await supabase.from("tournament_settings").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}
