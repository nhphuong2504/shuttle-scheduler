import { supabase } from "@/integrations/supabase/client";

import type { Team, Pool, PoolEntry, PoolMatch, DrawMatch, Settings, Court } from "./data";
import { buildFirstRound, tierForRank, type DrawTier } from "./draws";
import { gamesWinner, isLegalGameScore, type GameScore } from "./format";
import { circleMethod, splitIntoPools } from "./pools";
import {
  scheduleGroupStageGrasp,
  type GraspDiagnostics,
  type GraspOptions,
  type GraspScheduleResult,
  type GraspSchedulableMatch,
} from "./scheduler-grasp";
import {
  diffPlan,
  projectedFinishFromRemainingMatches,
  type SchedulePlanDiff,
} from "./schedule-diff";
import { scheduleMatches, type SchedulableMatch, type ScheduledSlot } from "./scheduler";
import { computeStandings, poolIsComplete } from "./standings";

async function ok<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  if (data == null) throw new Error("The record could not be found.");
  return data as NonNullable<T>;
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { error } = await supabase.rpc(name as never, args as never);
  if (error) throw new Error(error.message);
}

export interface ScheduleImpact {
  shiftedMatches: number;
  largestShiftMinutes: number;
  direction: "earlier" | "later" | "mixed" | "none";
}

type ScheduleSnapshot = Map<string, number>;

async function scheduleSnapshot(): Promise<ScheduleSnapshot> {
  const [pool, draw] = await Promise.all([
    supabase.from("pool_matches").select("id, scheduled_time").eq("status", "scheduled"),
    supabase.from("draw_matches").select("id, scheduled_time").eq("status", "scheduled"),
  ]);
  if (pool.error) throw new Error(pool.error.message);
  if (draw.error) throw new Error(draw.error.message);
  const snapshot = new Map<string, number>();
  for (const row of pool.data ?? []) {
    if (row.scheduled_time) {
      snapshot.set(`pool:${row.id}`, new Date(row.scheduled_time).getTime());
    }
  }
  for (const row of draw.data ?? []) {
    if (row.scheduled_time) {
      snapshot.set(`draw:${row.id}`, new Date(row.scheduled_time).getTime());
    }
  }
  return snapshot;
}

function compareSchedule(before: ScheduleSnapshot, after: ScheduleSnapshot): ScheduleImpact {
  const deltas: number[] = [];
  for (const [id, next] of after) {
    const previous = before.get(id);
    if (previous != null && previous !== next) deltas.push(Math.round((next - previous) / 60_000));
  }
  const earlier = deltas.some((delta) => delta < 0);
  const later = deltas.some((delta) => delta > 0);
  return {
    shiftedMatches: deltas.length,
    largestShiftMinutes: deltas.reduce((largest, delta) => Math.max(largest, Math.abs(delta)), 0),
    direction: earlier && later ? "mixed" : earlier ? "earlier" : later ? "later" : "none",
  };
}

async function withScheduleImpact(work: () => Promise<void>): Promise<ScheduleImpact> {
  const before = await scheduleSnapshot();
  await work();
  const after = await scheduleSnapshot();
  return compareSchedule(before, after);
}

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

export async function generatePoolsForCategory(categoryId: string, teams: Team[], force = false) {
  const active = teams.filter((t) => !t.withdrawn);
  const groups = splitIntoPools(active);
  const payload = groups.map((group, i) => ({
    name: `Pool ${String.fromCharCode(65 + i)}`,
    size: group.length,
    entries: group.map((t, idx) => ({ team_id: t.id, position: idx + 1 })),
    matches: circleMethod(group).map((p) => ({
      round: p.round,
      team_a_id: p.teamA.id,
      team_b_id: p.teamB.id,
    })),
  }));
  await rpc("apply_pool_generation", { p_category_id: categoryId, p_force: force, p_payload: payload });
}

export async function reportPoolMatch(matchId: string, scoreA: number, scoreB: number) {
  if (!isLegalGameScore(scoreA, scoreB)) throw new Error("A group match needs a race-to-21 winning score.");
  return withScheduleImpact(() =>
    rpc("report_pool_result", { p_match_id: matchId, p_score_a: scoreA, p_score_b: scoreB }),
  );
}

export async function startMatch(
  table: "pool_matches" | "draw_matches",
  matchId: string,
  courtId: string | null,
  ignoreRest = false,
) {
  if (!courtId) throw new Error("Select a court before starting the match.");
  await rpc("start_match_safe", {
    p_table: table,
    p_match_id: matchId,
    p_court_id: courtId,
    p_ignore_rest: ignoreRest,
  });
}

export async function rescheduleMatch(
  table: "pool_matches" | "draw_matches",
  matchId: string,
  courtId: string,
  scheduledTime: string,
) {
  await rpc("reschedule_live_match", {
    p_table: table,
    p_match_id: matchId,
    p_court_id: courtId,
    p_scheduled_time: scheduledTime,
  });
}

export async function resetMatch(
  table: "pool_matches" | "draw_matches",
  matchId: string,
  note: string,
) {
  await rpc("reset_match_with_note", {
    p_table: table,
    p_match_id: matchId,
    p_note: note,
  });
}

export async function resolveMatchException(
  table: "pool_matches" | "draw_matches",
  matchId: string,
  status: "walkover" | "void",
  winnerId: string | null,
  note: string,
) {
  return withScheduleImpact(() =>
    rpc("resolve_match_exception", {
      p_table: table,
      p_match_id: matchId,
      p_status: status,
      p_winner_id: winnerId,
      p_note: note,
    }),
  );
}

export async function setManualRankOverride(entryId: string, rank: number | null) {
  if (rank != null && (!Number.isInteger(rank) || rank < 1 || rank > 5)) {
    throw new Error("Manual rank must be an integer from 1 to 5.");
  }
  const { error } = await supabase.from("pool_entries").update({ manual_rank_override: rank }).eq("id", entryId);
  if (error) throw new Error(error.message);
}

export interface DrawGate {
  ready: boolean;
  waitingOn: string[];
}

export function drawGate(pools: Pool[], entries: PoolEntry[], matches: PoolMatch[]): DrawGate {
  const waitingOn: string[] = [];
  for (const pool of pools) {
    const teamIds = entries.filter((e) => e.pool_id === pool.id).map((e) => e.team_id);
    const poolMatches = matches.filter((m) => m.pool_id === pool.id);
    if (!poolIsComplete(teamIds, poolMatches)) waitingOn.push(pool.name);
  }
  return { ready: pools.length > 0 && waitingOn.length === 0, waitingOn };
}

export function entrantsByTier(pools: Pool[], entries: PoolEntry[], matches: PoolMatch[]) {
  const byTier: Record<DrawTier, { teamId: string; diff: number; wins: number; poolName: string; poolRank: number }[]> =
    { A: [], B: [], C: [], D: [] };
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

export async function generateDrawsForCategory(
  categoryId: string,
  pools: Pool[],
  entries: PoolEntry[],
  matches: PoolMatch[],
  force = false,
) {
  const gate = drawGate(pools, entries, matches);
  if (!gate.ready) throw new Error(`Waiting on results from ${gate.waitingOn.join(", ") || "the pools"}.`);
  const tiers = entrantsByTier(pools, entries, matches);
  const payload = (["A", "B", "C", "D"] as DrawTier[])
    .map((tier) => {
      const entrants = tiers[tier];
      if (!entrants.length) return null;
      const { bracketSize, pairs } = buildFirstRound(entrants);
      return {
        tier,
        bracket_size: bracketSize,
        entrant_count: entrants.length,
        matches: pairs.map((p) => ({
          round: 1,
          slot: p.slot,
          team_a_id: p.teamA,
          team_b_id: p.teamB,
          winner_id: p.isBye ? (p.teamA ?? p.teamB) : null,
          status: p.isBye || (!p.teamA && !p.teamB) ? "reported" : "scheduled",
          note: p.isBye ? "Bye" : null,
          is_bye: p.isBye,
        })),
      };
    })
    .filter(Boolean);
  await rpc("apply_draw_generation", { p_category_id: categoryId, p_force: force, p_payload: payload });
}

export async function reportDrawMatch(matchId: string, games: GameScore[]) {
  const side = gamesWinner(games);
  if (!side) throw new Error("Enter a valid best-of-three result (exactly two game wins).");
  return withScheduleImpact(() =>
    rpc("report_draw_result", { p_match_id: matchId, p_games: games }),
  );
}

function combineDateTime(date: string, time: string) {
  const normalized = time.length === 5 ? `${time}:00` : time;
  return new Date(`${date}T${normalized}`);
}

export interface ScheduleSummary {
  placed: number;
  anchorCount: number;
  movedCount: number;
  unscheduled: number;
  awaitingTeams: number;
  utilization: number;
  remainingUtilization: number | null;
  overrun: boolean;
  projectedFinish: string | null;
  currentProjectedFinish: string | null;
  projectedFinishDeltaMinutes: number | null;
  overrunMinutes: number;
  diagnostics?: GraspDiagnostics | undefined;
}

export interface DayPlan {
  day: 1 | 2;
  slots: ScheduledSlot[];
  fixedMatchIds: string[];
  blocked: string[];
  awaitingTeams: string[];
  diff: SchedulePlanDiff;
  summary: ScheduleSummary;
  settingsPatch: Partial<Settings> | null;
  settingsId: string;
  poolEnds: Record<string, string>;
  movableSlotPayload: { match_id: string; scheduled_time: string; court_id: string }[];
}

export type DayOneSchedulerOptions = Pick<
  GraspOptions,
  | "categoryFragmentationGapMinutes"
  | "rclSize"
  | "graspRuns"
  | "seed"
  | "debugTrace"
  | "maxIterationsPerRun"
>;

function partitionUnscheduled(
  unscheduled: string[],
  items: GraspSchedulableMatch[],
): { blocked: string[]; awaitingTeams: string[] } {
  const blocked: string[] = [];
  const awaitingTeams: string[] = [];
  for (const id of unscheduled) {
    const item = items.find((match) => match.id === id);
    if (!item || item.playersKnown === false || item.playerIds.length === 0) {
      awaitingTeams.push(id);
    } else {
      blocked.push(id);
    }
  }
  return { blocked, awaitingTeams };
}

function anchorStart(
  scheduledTime: string | null,
  startedAt: string | null,
): number | undefined {
  const anchor = startedAt ?? scheduledTime;
  return anchor ? new Date(anchor).getTime() : undefined;
}

export function planDay(
  day: 1 | 2,
  settings: Settings,
  courts: Court[],
  teams: Team[],
  poolMatches: PoolMatch[],
  drawMatches: DrawMatch[],
  drawCategory: Map<string, string>,
  categoryOrder: Map<string, number>,
  graspOptions?: DayOneSchedulerOptions,
  settingsPatch?: Partial<Settings> | null,
): DayPlan {
  if (!courts.length) throw new Error("Load the court list before building a schedule.");
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

  const slotMinutes = day === 1 ? settings.group_slot_minutes : settings.knockout_slot_minutes;
  const restGap = day === 1 ? settings.group_rest_gap_minutes : settings.knockout_rest_gap_minutes;
  const date = day === 1 ? settings.day_1 : settings.day_2;
  const dayStart = combineDateTime(date, settings.day_start_time);
  const planningEnd = combineDateTime(date, settings.planning_end_time || "17:00:00");
  const nextWholeMinute = Math.ceil(Date.now() / 60_000) * 60_000;
  const isDayOneRebuild =
    day === 1 &&
    poolMatches.some((match) => match.status !== "void" && match.scheduled_time != null);
  const schedulingFloor = isDayOneRebuild
    ? new Date(Math.max(dayStart.getTime(), nextWholeMinute))
    : dayStart;
  const items: GraspSchedulableMatch[] =
    day === 1
      ? poolMatches
          .filter((m) => m.status !== "void")
          .map((m) => {
            const ids = playersOf(m.team_a_id, m.team_b_id);
            const playersKnown = Boolean(
              m.team_a_id && m.team_b_id && teamById.has(m.team_a_id) && teamById.has(m.team_b_id),
            );
            if ((m.team_a_id || m.team_b_id) && ids.length === 0) {
              throw new Error("A scheduled group match is missing player records.");
            }
            const start = anchorStart(m.scheduled_time, m.started_at);
            const fixed =
              m.status === "reported" || m.status === "in-progress" || m.status === "walkover";
            const plannedEnd = start != null ? start + slotMinutes * 60_000 : undefined;
            const end =
              m.ended_at && (m.status === "reported" || m.status === "walkover")
                ? new Date(m.ended_at).getTime()
                : m.status === "in-progress" && plannedEnd != null
                  ? Math.max(plannedEnd, schedulingFloor.getTime() + slotMinutes * 60_000)
                  : plannedEnd;
            return {
              id: m.id,
              categoryId: m.category_id,
              categoryOrder: categoryOrder.get(m.category_id) ?? 0,
              poolId: m.pool_id,
              playerIds: ids,
              playersKnown,
              kind: "group" as const,
              order: m.round,
              round: m.round,
              fixed,
              start,
              end,
              courtNumber: courts.find((c) => c.id === m.court_id)?.number,
            };
          })
      : drawMatches
          .filter((m) => !m.is_bye && m.status !== "void")
          .map((m) => {
            const ids = playersOf(m.team_a_id, m.team_b_id);
            if (m.team_a_id && m.team_b_id && ids.length === 0) {
              throw new Error("A scheduled knockout match is missing player records.");
            }
            const parents = drawMatches.filter(
              (p) => p.id === m.parent_a_id || p.id === m.parent_b_id,
            );
            const parentEnd = parents.reduce((acc, p) => {
              const t = p.ended_at ?? p.reported_time;
              return t ? Math.max(acc, new Date(t).getTime() + restGap * 60_000) : acc;
            }, 0);
            const start = anchorStart(m.scheduled_time, m.started_at);
            const fixed =
              m.status === "reported" || m.status === "in-progress" || m.status === "walkover";
            const plannedEnd = start != null ? start + slotMinutes * 60_000 : undefined;
            return {
              id: m.id,
              categoryId: drawCategory.get(m.draw_id) ?? m.draw_id,
              categoryOrder: categoryOrder.get(drawCategory.get(m.draw_id) ?? "") ?? 0,
              playerIds: ids,
              kind: "knockout" as const,
              order: m.round * 100 + m.slot,
              earliestStart: parentEnd || undefined,
              fixed,
              start,
              end:
                m.ended_at && (m.status === "reported" || m.status === "walkover")
                  ? new Date(m.ended_at).getTime()
                  : m.status === "in-progress" && plannedEnd != null
                    ? Math.max(plannedEnd, Date.now() + slotMinutes * 60_000)
                    : plannedEnd,
              courtNumber: courts.find((c) => c.id === m.court_id)?.number,
            };
          })
          .filter(
            (m) =>
              m.fixed ||
              (m.playerIds.length > 0 &&
                drawMatches.find((d) => d.id === m.id)?.status !== "reported"),
          );

  const result =
    day === 1
      ? scheduleGroupStageGrasp(items, {
          dayStart,
          planningEnd,
          schedulingFloor,
          courts,
          slotMinutes,
          restGapMinutes: restGap,
          ...graspOptions,
        })
      : scheduleMatches(items as SchedulableMatch[], {
          dayStart,
          planningEnd,
          courts,
          slotMinutes,
          restGapMinutes: restGap,
        });

  const fixedMatchIds = items.filter((item) => item.fixed).map((item) => item.id);
  const fixedSet = new Set(fixedMatchIds);
  const { blocked, awaitingTeams } = partitionUnscheduled(result.unscheduled, items);
  const courtNumberById = new Map(courts.map((court) => [court.id, court.number]));
  const diff = diffPlan(
    day === 1 ? poolMatches : drawMatches,
    result.slots,
    fixedSet,
    courtNumberById,
  );
  diff.unplaceable = blocked;

  const poolEnds: Record<string, string> = {};
  if (day === 1) {
    for (const slot of result.slots) {
      const match = poolMatches.find((m) => m.id === slot.matchId);
      if (!match) continue;
      const prev = poolEnds[match.pool_id];
      if (!prev || new Date(prev).getTime() < slot.end.getTime()) {
        poolEnds[match.pool_id] = slot.end.toISOString();
      }
    }
  }

  const movableSlotPayload = result.slots
    .filter((slot) => !fixedSet.has(slot.matchId))
    .map((slot) => ({
      match_id: slot.matchId,
      scheduled_time: slot.start.toISOString(),
      court_id: slot.courtId,
    }));

  const graspResult = day === 1 ? (result as GraspScheduleResult) : null;
  const currentFinishMs =
    day === 1 && isDayOneRebuild
      ? projectedFinishFromRemainingMatches(poolMatches, slotMinutes)
      : null;
  const newFinishMs = result.projectedFinish?.getTime() ?? null;
  const projectedFinishDeltaMinutes =
    currentFinishMs != null && newFinishMs != null
      ? Math.round((newFinishMs - currentFinishMs) / 60_000)
      : null;
  const summary: ScheduleSummary = {
    placed: diff.placedCount,
    anchorCount: diff.anchorCount,
    movedCount: diff.movedCount,
    unscheduled: blocked.length,
    awaitingTeams: awaitingTeams.length,
    utilization: result.utilization,
    remainingUtilization: graspResult?.diagnostics.remainingWindowUtilization ?? null,
    overrun: result.overrun,
    projectedFinish: result.projectedFinish?.toISOString() ?? null,
    currentProjectedFinish:
      currentFinishMs != null ? new Date(currentFinishMs).toISOString() : null,
    projectedFinishDeltaMinutes,
    overrunMinutes: result.overrunMinutes,
    ...(graspResult ? { diagnostics: graspResult.diagnostics } : {}),
  };

  return {
    day,
    slots: result.slots,
    fixedMatchIds,
    blocked,
    awaitingTeams,
    diff,
    summary,
    settingsPatch: settingsPatch ?? null,
    settingsId: settings.id,
    poolEnds,
    movableSlotPayload,
  };
}

export async function applyDayPlan(plan: DayPlan): Promise<ScheduleImpact> {
  if (plan.blocked.length > 0) {
    const reason = plan.summary.diagnostics?.deadlockReason;
    throw new Error(
      reason
        ? `Cannot apply rebuild: ${plan.blocked.length} match(es) could not be placed. ${reason}`
        : `Cannot apply rebuild: ${plan.blocked.length} match(es) could not be placed.`,
    );
  }

  if (plan.settingsPatch && Object.keys(plan.settingsPatch).length > 0) {
    await updateSettings(plan.settingsId, plan.settingsPatch);
  }

  return withScheduleImpact(() =>
    rpc("apply_day_schedule", {
      p_day: plan.day,
      p_slots: plan.movableSlotPayload,
      p_pool_ends: plan.poolEnds,
    }),
  );
}

export async function updateSettings(id: string, patch: Partial<Settings>) {
  const { error } = await supabase.from("tournament_settings").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function inviteStaff(email: string, role: "admin" | "registrar" | "scorer" | "scheduler") {
  const { error } = await supabase.from("staff_roles").insert({ email: email.trim().toLowerCase(), role });
  if (error) throw new Error(error.message);
}

export async function removeStaff(id: string) {
  const { error } = await supabase.from("staff_roles").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
