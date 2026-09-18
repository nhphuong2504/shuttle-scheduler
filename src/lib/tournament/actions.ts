import { supabase } from "@/integrations/supabase/client";

import type {
  Court,
  DrawMatch,
  Pool,
  PoolEntry,
  PoolMatch,
  StageName,
  Team,
  Tournament,
  TournamentDay,
} from "./data";
import { buildFirstRound, tierForRank, type DrawTier } from "./draws";
import type { FinishEstimate } from "./finish-estimate";
import { gamesWinner, isLegalGameScore, type GameScore } from "./format";
import { circleMethod, splitIntoPools } from "./pools";
import type { SolverDiagnostics } from "@/lib/scheduling";
import { composeDayPlan, type ComposedAnchor, type ComposedMatch } from "./scheduling/composition";
import type { DayOneSchedulerOptions } from "./scheduling/policy";
import type { ScheduledSlot } from "./scheduling/types";
import {
  diffPlan,
  projectedFinishFromRemainingMatches,
  type SchedulePlanDiff,
} from "./schedule-diff";
import { computeStandings, poolIsComplete } from "./standings";

async function ok<T>(
  p: PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<NonNullable<T>> {
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

/** The active tournament, unless a caller already knows which one it means. */
async function resolveTournamentId(explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  const { data, error } = await supabase
    .from("tournaments")
    .select("id")
    .eq("is_active", true)
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0]?.id ?? null;
}

async function scheduleSnapshot(tournamentId: string | null): Promise<ScheduleSnapshot> {
  const snapshot = new Map<string, number>();
  if (!tournamentId) return snapshot;
  const [pool, draw] = await Promise.all([
    supabase
      .from("pool_matches")
      .select("id, scheduled_time")
      .eq("tournament_id", tournamentId)
      .eq("status", "scheduled"),
    supabase
      .from("draw_matches")
      .select("id, scheduled_time")
      .eq("tournament_id", tournamentId)
      .eq("status", "scheduled"),
  ]);
  if (pool.error) throw new Error(pool.error.message);
  if (draw.error) throw new Error(draw.error.message);
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

/** Schedule impact is measured inside a single tournament, never across two. */
async function withScheduleImpact(
  work: () => Promise<void>,
  tournamentId?: string | null,
): Promise<ScheduleImpact> {
  const scope = await resolveTournamentId(tournamentId);
  const before = await scheduleSnapshot(scope);
  await work();
  const after = await scheduleSnapshot(scope);
  return compareSchedule(before, after);
}

export async function createPlayer(input: {
  name: string;
  email?: string;
  phone?: string;
  gender?: string;
}) {
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

// `tournament_id` is intentionally omitted: the `teams_shape` trigger derives it
// from the category, and the cap trigger rejects entries past `max_entries`.
export async function createTeam(input: {
  categoryId: string;
  player1: string;
  player2: string | null;
}) {
  return ok(
    supabase
      .from("teams")
      .insert({
        category_id: input.categoryId,
        player_1_id: input.player1,
        player_2_id: input.player2,
      } as never)
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
  await rpc("apply_pool_generation", {
    p_category_id: categoryId,
    p_force: force,
    p_payload: payload,
  });
}

export async function reportPoolMatch(matchId: string, scoreA: number, scoreB: number) {
  if (!isLegalGameScore(scoreA, scoreB))
    throw new Error("A group match needs a race-to-21 winning score.");
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
  const { error } = await supabase
    .from("pool_entries")
    .update({ manual_rank_override: rank })
    .eq("id", entryId);
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
  const byTier: Record<
    DrawTier,
    { teamId: string; diff: number; wins: number; poolName: string; poolRank: number }[]
  > = { A: [], B: [], C: [], D: [] };
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
  if (!gate.ready)
    throw new Error(`Waiting on results from ${gate.waitingOn.join(", ") || "the pools"}.`);
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
  await rpc("apply_draw_generation", {
    p_category_id: categoryId,
    p_force: force,
    p_payload: payload,
  });
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
  diagnostics?: SolverDiagnostics | undefined;
  /**
   * Placement format only: the forecast from the rebuilt plan, including work with no row yet.
   * Legacy `planDay` leaves it absent, so its semantics are unchanged.
   */
  estimate?: FinishEstimate | undefined;
  /** Placement format only: the forecast from the current live state, for the delta. */
  currentEstimate?: FinishEstimate | undefined;
}

export interface DayPlan {
  day: number;
  stage: StageName;
  tournamentId: string;
  slots: ScheduledSlot[];
  fixedMatchIds: string[];
  blocked: string[];
  awaitingTeams: string[];
  diff: SchedulePlanDiff;
  summary: ScheduleSummary;
  poolEnds: Record<string, string>;
  movableSlotPayload: { match_id: string; scheduled_time: string; court_id: string }[];
}

export type { DayOneSchedulerOptions };

function partitionUnscheduled(
  unscheduled: readonly string[],
  items: readonly ComposedMatch[],
): { blocked: string[]; awaitingTeams: string[] } {
  const blocked: string[] = [];
  const awaitingTeams: string[] = [];
  for (const id of unscheduled) {
    const item = items.find((match) => match.id === id);
    if (!item || item.participantsKnown === false || item.participantIds.length === 0) {
      awaitingTeams.push(id);
    } else {
      blocked.push(id);
    }
  }
  return { blocked, awaitingTeams };
}

function anchorStart(scheduledTime: string | null, startedAt: string | null): number | undefined {
  const anchor = startedAt ?? scheduledTime;
  return anchor ? new Date(anchor).getTime() : undefined;
}

export function planDay(
  day: number,
  stage: StageName,
  tournament: Tournament,
  dayConfig: TournamentDay,
  courts: Court[],
  teams: Team[],
  poolMatches: PoolMatch[],
  drawMatches: DrawMatch[],
  drawCategory: Map<string, string>,
  categoryOrder: Map<string, number>,
  graspOptions?: DayOneSchedulerOptions,
): DayPlan {
  if (!courts.length) throw new Error("Load the court list before building a schedule.");
  const isGroupStage = stage === "group";
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

  const slotMinutes = isGroupStage
    ? tournament.group_slot_minutes
    : tournament.knockout_slot_minutes;
  const restGap = isGroupStage
    ? tournament.group_rest_gap_minutes
    : tournament.knockout_rest_gap_minutes;
  const date = dayConfig.date;
  const dayStart = combineDateTime(date, dayConfig.start_time);
  const planningEnd = combineDateTime(date, dayConfig.end_time);
  const nextWholeMinute = Math.ceil(Date.now() / 60_000) * 60_000;
  const isGroupRebuild =
    isGroupStage &&
    poolMatches.some((match) => match.status !== "void" && match.scheduled_time != null);
  const schedulingFloor = isGroupRebuild
    ? new Date(Math.max(dayStart.getTime(), nextWholeMinute))
    : dayStart;

  const allowedCourtIds = new Set(courts.map((court) => court.id));
  const fallbackCourtId = courts[0]!.id;
  /**
   * A fixed match must name a court. A match whose recorded court is not one this day is playing
   * on falls back to the first court, which keeps it pinned instead of making the problem invalid.
   */
  const fixedCourtId = (courtId: string | null): string =>
    courtId && allowedCourtIds.has(courtId) ? courtId : fallbackCourtId;

  /**
   * A fixed match with a court is a `ScheduleMatch`; one without (reported before it was ever laid
   * out) becomes a `ParticipantAnchor`, so it occupies no court but its players still get their
   * rest and its end still counts toward the day's real finish. A fixed match with no times at all
   * is dropped, as the legacy engine did.
   */
  const items: ComposedMatch[] = [];
  const anchors: ComposedAnchor[] = [];

  if (isGroupStage) {
    for (const m of poolMatches) {
      if (m.status === "void") continue;
      const ids = playersOf(m.team_a_id, m.team_b_id);
      const participantsKnown = Boolean(
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

      if (fixed && start != null && end != null) {
        if (m.court_id && allowedCourtIds.has(m.court_id)) {
          items.push({
            id: m.id,
            categoryId: m.category_id,
            participantIds: ids,
            participantsKnown,
            durationMinutes: slotMinutes,
            restAfterMinutes: restGap,
            groupKey: m.pool_id,
            sequence: m.round,
            softOrder: categoryOrder.get(m.category_id) ?? 0,
            fixed: true,
            start,
            end,
            resourceId: m.court_id,
          });
        } else {
          anchors.push({
            id: m.id,
            participantIds: ids,
            start,
            end,
            restAfterMinutes: restGap,
          });
        }
        continue;
      }
      if (fixed) continue;

      items.push({
        id: m.id,
        categoryId: m.category_id,
        participantIds: ids,
        participantsKnown,
        durationMinutes: slotMinutes,
        restAfterMinutes: restGap,
        groupKey: m.pool_id,
        sequence: m.round,
        softOrder: categoryOrder.get(m.category_id) ?? 0,
      });
    }
  } else {
    for (const m of drawMatches) {
      if (m.is_bye || m.status === "void") continue;
      const ids = playersOf(m.team_a_id, m.team_b_id);
      if (m.team_a_id && m.team_b_id && ids.length === 0) {
        throw new Error("A scheduled knockout match is missing player records.");
      }
      const parents = drawMatches.filter((p) => p.id === m.parent_a_id || p.id === m.parent_b_id);
      const parentEnd = parents.reduce((acc, p) => {
        const t = p.ended_at ?? p.reported_time;
        return t ? Math.max(acc, new Date(t).getTime() + restGap * 60_000) : acc;
      }, 0);
      const start = anchorStart(m.scheduled_time, m.started_at);
      const fixed =
        m.status === "reported" || m.status === "in-progress" || m.status === "walkover";
      const plannedEnd = start != null ? start + slotMinutes * 60_000 : undefined;
      const end =
        m.ended_at && (m.status === "reported" || m.status === "walkover")
          ? new Date(m.ended_at).getTime()
          : m.status === "in-progress" && plannedEnd != null
            ? Math.max(plannedEnd, Date.now() + slotMinutes * 60_000)
            : plannedEnd;
      const categoryId = drawCategory.get(m.draw_id) ?? m.draw_id;

      if (fixed && start != null && end != null) {
        if (m.court_id && allowedCourtIds.has(m.court_id)) {
          items.push({
            id: m.id,
            categoryId,
            participantIds: ids,
            participantsKnown: ids.length > 0,
            durationMinutes: slotMinutes,
            restAfterMinutes: restGap,
            groupKey: categoryId,
            sequence: m.round * 100 + m.slot,
            softOrder: categoryOrder.get(categoryId) ?? 0,
            fixed: true,
            start,
            end,
            resourceId: m.court_id,
          });
        } else {
          anchors.push({
            id: m.id,
            participantIds: ids,
            start,
            end,
            restAfterMinutes: restGap,
          });
        }
        continue;
      }
      if (fixed) continue;
      if (!(ids.length > 0 && m.status !== "reported")) continue;

      items.push({
        id: m.id,
        categoryId,
        participantIds: ids,
        participantsKnown: true,
        durationMinutes: slotMinutes,
        restAfterMinutes: restGap,
        groupKey: categoryId,
        sequence: m.round * 100 + m.slot,
        softOrder: categoryOrder.get(categoryId) ?? 0,
        ...(parentEnd ? { eligibleFrom: parentEnd } : {}),
      });
    }
  }

  const composed = composeDayPlan({
    matches: items,
    resources: courts.map((court) => ({
      id: court.id,
      order: court.number,
      label: `Court ${court.number}`,
    })),
    ...(anchors.length ? { anchors } : {}),
    horizonStart: dayStart.getTime(),
    planningEnd: planningEnd.getTime(),
    floor: schedulingFloor.getTime(),
    ...(graspOptions ? { options: graspOptions } : {}),
  });
  const solution = composed.solution;
  const resultSlots = composed.slots;

  const fixedMatchIds = [
    ...items.filter((item) => item.fixed).map((item) => item.id),
    ...anchors.map((anchor) => anchor.id),
  ];
  const fixedSet = new Set(fixedMatchIds);
  const { blocked, awaitingTeams } = partitionUnscheduled(solution.unscheduled, items);
  const courtNumberById = new Map(courts.map((court) => [court.id, court.number]));
  const diff = diffPlan(
    isGroupStage ? poolMatches : drawMatches,
    resultSlots,
    fixedSet,
    courtNumberById,
  );
  diff.unplaceable = blocked;

  const poolEnds: Record<string, string> = {};
  if (isGroupStage) {
    for (const slot of resultSlots) {
      const match = poolMatches.find((m) => m.id === slot.matchId);
      if (!match) continue;
      const prev = poolEnds[match.pool_id];
      if (!prev || new Date(prev).getTime() < slot.end.getTime()) {
        poolEnds[match.pool_id] = slot.end.toISOString();
      }
    }
  }

  const movableSlotPayload = resultSlots
    .filter((slot) => !fixedSet.has(slot.matchId))
    .map((slot) => ({
      match_id: slot.matchId,
      scheduled_time: slot.start.toISOString(),
      court_id: slot.courtId,
    }));

  const currentFinishMs =
    isGroupStage && isGroupRebuild
      ? projectedFinishFromRemainingMatches(poolMatches, slotMinutes)
      : null;
  const newFinishMs = solution.knownFinish;
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
    utilization: solution.windowUtilization,
    remainingUtilization: solution.diagnostics.remainingWindowUtilization,
    overrun: solution.knownOverrun,
    projectedFinish: newFinishMs != null ? new Date(newFinishMs).toISOString() : null,
    currentProjectedFinish:
      currentFinishMs != null ? new Date(currentFinishMs).toISOString() : null,
    projectedFinishDeltaMinutes,
    overrunMinutes: solution.knownOverrunMinutes,
    diagnostics: solution.diagnostics,
  };

  return {
    day,
    stage,
    tournamentId: tournament.id,
    slots: resultSlots,
    fixedMatchIds,
    blocked,
    awaitingTeams,
    diff,
    summary,
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

  return withScheduleImpact(
    () =>
      rpc("apply_day_schedule", {
        p_tournament_id: plan.tournamentId,
        p_day: plan.day,
        p_stage: plan.stage,
        p_slots: plan.movableSlotPayload,
        p_pool_ends: plan.poolEnds,
      }),
    plan.tournamentId,
  );
}

/** The schedule page edits a `tournament_days` row directly. */
export async function updateTournamentDay(
  id: string,
  patch: Partial<Pick<TournamentDay, "date" | "start_time" | "end_time">>,
) {
  const { error } = await supabase.from("tournament_days").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

/** The durations and rest gaps a build is measured against. */
export interface TournamentTimingsInput {
  groupSlotMinutes?: number;
  knockoutSlotMinutes?: number;
  groupRestGapMinutes?: number;
  knockoutRestGapMinutes?: number;
}

/**
 * Overrides the durations and rest gaps the schedule is built from.
 *
 * A direct table update rather than `save_tournament_draft`, which deliberately
 * refuses anything that is not a DRAFT row. Overriding mid-event is the point:
 * the desk finds out on the day that matches are running long, or that players
 * need longer between them, and must be able to replan without a new tournament.
 *
 * The guard rails mirror the readiness check (`slot > 0`, `rest >= 0`) so an
 * override cannot quietly make a tournament fail its own readiness gate.
 */
export async function updateTournamentTimings(
  tournamentId: string,
  patch: TournamentTimingsInput,
): Promise<void> {
  const payload: {
    group_slot_minutes?: number;
    knockout_slot_minutes?: number;
    group_rest_gap_minutes?: number;
    knockout_rest_gap_minutes?: number;
  } = {};
  if (patch.groupSlotMinutes !== undefined) payload.group_slot_minutes = patch.groupSlotMinutes;
  if (patch.knockoutSlotMinutes !== undefined)
    payload.knockout_slot_minutes = patch.knockoutSlotMinutes;
  if (patch.groupRestGapMinutes !== undefined)
    payload.group_rest_gap_minutes = patch.groupRestGapMinutes;
  if (patch.knockoutRestGapMinutes !== undefined)
    payload.knockout_rest_gap_minutes = patch.knockoutRestGapMinutes;
  if (!Object.keys(payload).length) return;

  if (payload.group_slot_minutes !== undefined && payload.group_slot_minutes <= 0) {
    throw new Error("A placement match must last at least one minute.");
  }
  if (payload.knockout_slot_minutes !== undefined && payload.knockout_slot_minutes <= 0) {
    throw new Error("A knockout match must last at least one minute.");
  }
  if (payload.group_rest_gap_minutes !== undefined && payload.group_rest_gap_minutes < 0) {
    throw new Error("The placement rest gap cannot be negative.");
  }
  if (payload.knockout_rest_gap_minutes !== undefined && payload.knockout_rest_gap_minutes < 0) {
    throw new Error("The knockout rest gap cannot be negative.");
  }

  const { error } = await supabase.from("tournaments").update(payload).eq("id", tournamentId);
  if (error) throw new Error(error.message);
}

/**
 * Replaces which courts a day plays on.
 *
 * Deletes by day rather than diffing: the set is small, it has no dependants, and
 * a diff would need to match rows that carry no natural key. The tournament's own
 * court pool is left alone, so shrinking a day's set never removes a court that
 * other days — or an already-scheduled match — still point at.
 *
 * An empty set means "no per-day restriction", which the scheduler reads as every
 * court. That is the same as the pre-existing rows state, so clearing is safe.
 */
export async function setTournamentDayCourts(
  tournamentId: string,
  dayId: string,
  courtIds: string[],
): Promise<void> {
  const { error: deleteError } = await supabase
    .from("tournament_day_courts")
    .delete()
    .eq("day_id", dayId);
  if (deleteError) throw new Error(deleteError.message);
  if (!courtIds.length) return;

  const { error } = await supabase
    .from("tournament_day_courts")
    .insert(courtIds.map((court_id) => ({ tournament_id: tournamentId, day_id: dayId, court_id })));
  if (error) throw new Error(error.message);
}

export interface TournamentDayBreakInput {
  label: string;
  startTime: string;
  endTime: string;
}

/**
 * Replaces a day's breaks.
 *
 * Validated before the delete so a rejected list cannot leave the day with none:
 * the database check constraint would otherwise fire after the old rows are gone.
 */
export async function setTournamentDayBreaks(
  tournamentId: string,
  dayId: string,
  breaks: TournamentDayBreakInput[],
): Promise<void> {
  for (const brk of breaks) {
    if (!brk.startTime || !brk.endTime) {
      throw new Error("A break needs both a start and an end time.");
    }
    // Both are zero-padded 24-hour strings, so lexical order is chronological.
    if (brk.endTime <= brk.startTime) {
      throw new Error(`Break "${brk.label || "untitled"}" must end after it starts.`);
    }
  }

  const { error: deleteError } = await supabase
    .from("tournament_day_breaks")
    .delete()
    .eq("day_id", dayId);
  if (deleteError) throw new Error(deleteError.message);
  if (!breaks.length) return;

  const { error } = await supabase.from("tournament_day_breaks").insert(
    breaks.map((brk) => ({
      tournament_id: tournamentId,
      day_id: dayId,
      label: brk.label || null,
      start_time: brk.startTime,
      end_time: brk.endTime,
    })),
  );
  if (error) throw new Error(error.message);
}

export interface TournamentCategoryInput {
  code: string;
  name: string;
  entryType: string;
  sortOrder: number;
  active: boolean;
  maxEntries: number | null;
}

export interface CreateTournamentInput {
  name: string;
  dayCount: number;
  courtCount: number;
  startDate: string;
  categories: TournamentCategoryInput[];
}

/**
 * Creates a tournament and everything it owns (days, courts, categories) in one
 * transaction, then makes it the active tournament.
 */
// ---------------------------------------------------------------------------
// Tournament creation: a persisted, resumable draft
//
// The wizard writes a Draft tournament on its first step and saves each later
// step into the same row, so an unfinished creation survives a refresh. Only
// `activateTournament` moves a draft to In Progress and makes it the active
// scope. Every one of these calls is admin-only at the database level.
// ---------------------------------------------------------------------------

/** The identity, venue, organizer and rules captured by the basics and rules steps. */
export interface TournamentDraftInput {
  name: string;
  format?: string;
  /** A note about the event, written to be read. Empty clears it. */
  notes?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  venueTimezone?: string;
  organizerName?: string | null;
  organizerEmail?: string | null;
  organizerPhone?: string | null;
  maxCategoriesPerPlayer?: number;
  placementGamesTo?: number;
  placementWinBy?: number;
  placementBestOf?: number;
  knockoutGamesTo?: number;
  knockoutWinBy?: number;
  knockoutBestOf?: number;
  groupSlotMinutes?: number;
  knockoutSlotMinutes?: number;
  groupRestGapMinutes?: number;
  knockoutRestGapMinutes?: number;
}

/** The JSON keys are the database column names, so they are declared explicitly. */
interface DraftPayload {
  name: string;
  format?: string;
  notes?: string;
  venue_name?: string;
  venue_address?: string;
  venue_timezone?: string;
  organizer_name?: string;
  organizer_email?: string;
  organizer_phone?: string;
  max_categories_per_player?: number;
  placement_games_to?: number;
  placement_win_by?: number;
  placement_best_of?: number;
  knockout_games_to?: number;
  knockout_win_by?: number;
  knockout_best_of?: number;
  group_slot_minutes?: number;
  knockout_slot_minutes?: number;
  group_rest_gap_minutes?: number;
  knockout_rest_gap_minutes?: number;
}

function draftBasicsPayload(input: TournamentDraftInput): DraftPayload {
  const payload: DraftPayload = { name: input.name.trim() };
  if (input.format !== undefined) payload.format = input.format;
  // The RPC treats an empty string as "no note", so clearing the box works.
  if (input.notes !== undefined) payload.notes = input.notes ?? "";
  if (input.venueName !== undefined) payload.venue_name = input.venueName ?? "";
  if (input.venueAddress !== undefined) payload.venue_address = input.venueAddress ?? "";
  if (input.venueTimezone !== undefined) payload.venue_timezone = input.venueTimezone;
  if (input.organizerName !== undefined) payload.organizer_name = input.organizerName ?? "";
  if (input.organizerEmail !== undefined) payload.organizer_email = input.organizerEmail ?? "";
  if (input.organizerPhone !== undefined) payload.organizer_phone = input.organizerPhone ?? "";
  if (input.maxCategoriesPerPlayer !== undefined)
    payload.max_categories_per_player = input.maxCategoriesPerPlayer;
  if (input.placementGamesTo !== undefined) payload.placement_games_to = input.placementGamesTo;
  if (input.placementWinBy !== undefined) payload.placement_win_by = input.placementWinBy;
  if (input.placementBestOf !== undefined) payload.placement_best_of = input.placementBestOf;
  if (input.knockoutGamesTo !== undefined) payload.knockout_games_to = input.knockoutGamesTo;
  if (input.knockoutWinBy !== undefined) payload.knockout_win_by = input.knockoutWinBy;
  if (input.knockoutBestOf !== undefined) payload.knockout_best_of = input.knockoutBestOf;
  if (input.groupSlotMinutes !== undefined) payload.group_slot_minutes = input.groupSlotMinutes;
  if (input.knockoutSlotMinutes !== undefined)
    payload.knockout_slot_minutes = input.knockoutSlotMinutes;
  if (input.groupRestGapMinutes !== undefined)
    payload.group_rest_gap_minutes = input.groupRestGapMinutes;
  if (input.knockoutRestGapMinutes !== undefined)
    payload.knockout_rest_gap_minutes = input.knockoutRestGapMinutes;
  return payload;
}

/** Creates an empty draft and returns its id. */
export async function createTournamentDraft(input: TournamentDraftInput): Promise<string> {
  const { data, error } = await supabase.rpc("create_tournament_draft", {
    p_payload: {
      name: input.name.trim(),
      format: input.format ?? "two_round_placement",
      notes: input.notes ?? "",
      venue_name: input.venueName ?? "",
      venue_address: input.venueAddress ?? "",
      venue_timezone: input.venueTimezone ?? "America/Chicago",
      organizer_name: input.organizerName ?? "",
      organizer_email: input.organizerEmail ?? "",
      organizer_phone: input.organizerPhone ?? "",
    } as never,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Saves basics, the tournament-wide cap and the per-stage match rules. */
export async function saveTournamentDraft(
  tournamentId: string,
  input: TournamentDraftInput,
): Promise<void> {
  const { error } = await supabase.rpc("save_tournament_draft", {
    p_tournament_id: tournamentId,
    p_payload: draftBasicsPayload(input) as never,
  });
  if (error) throw new Error(error.message);
}

export interface TournamentDayInput {
  date: string;
  startTime: string;
  endTime: string;
  /** Court numbers available that day. The tournament's court pool is their union. */
  courts: number[];
  breaks: { label: string; startTime: string; endTime: string }[];
}

/**
 * Replaces the whole day/court/break configuration. The database renumbers the
 * court pool 1..N from the union of the days' court numbers.
 */
export async function saveTournamentDays(
  tournamentId: string,
  days: TournamentDayInput[],
): Promise<void> {
  const { error } = await supabase.rpc("save_tournament_days", {
    p_tournament_id: tournamentId,
    p_days: days.map((day) => ({
      date: day.date,
      start_time: day.startTime,
      end_time: day.endTime,
      courts: day.courts,
      breaks: day.breaks.map((br) => ({
        label: br.label,
        start_time: br.startTime,
        end_time: br.endTime,
      })),
    })) as never,
  });
  if (error) throw new Error(error.message);
}

export interface TournamentEventInput {
  code: string;
  name: string;
  entryType: "individual" | "pair";
  gender: "men" | "women" | "mixed" | "open";
  sortOrder?: number;
  active?: boolean;
  maxEntries?: number | null;
}

/** Replaces the event list. Only a draft with no entries may be rewritten. */
export async function saveTournamentEvents(
  tournamentId: string,
  events: TournamentEventInput[],
): Promise<void> {
  const { error } = await supabase.rpc("save_tournament_categories", {
    p_tournament_id: tournamentId,
    p_categories: events.map((event, index) => ({
      code: event.code,
      name: event.name,
      entry_type: event.entryType,
      gender: event.gender,
      sort_order: event.sortOrder ?? index + 1,
      active: event.active ?? true,
      max_entries: event.maxEntries ?? null,
    })) as never,
  });
  if (error) throw new Error(error.message);
}

/** Draft -> In Progress. Re-checks readiness and makes it the active scope. */
export async function activateTournament(tournamentId: string): Promise<void> {
  const { error } = await supabase.rpc("activate_tournament", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
}

/** Discards a draft and everything it owns. */
export async function deleteTournamentDraft(tournamentId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_tournament_draft", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Removes a tournament of any status, including an active one, along with
 * everything it owns. Permanent and not reversible.
 *
 * Kept separate from `deleteTournamentDraft`, which deliberately refuses to touch
 * anything that is not a Draft: that refusal is what protects the wizard's
 * "Discard draft" button. This is the explicitly destructive path.
 */
export async function deleteTournament(tournamentId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_tournament", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Creates an active tournament in one call. Superseded by the draft wizard, and
 * kept only so any remaining caller still compiles.
 *
 * @deprecated Use `createTournamentDraft` followed by `activateTournament`.
 */
export async function createTournament(input: CreateTournamentInput): Promise<string> {
  const payload = input.categories.map((c) => ({
    code: c.code,
    name: c.name,
    entry_type: c.entryType,
    sort_order: c.sortOrder,
    active: c.active,
    max_entries: c.maxEntries,
  }));
  const { data, error } = await supabase.rpc("create_tournament", {
    p_name: input.name.trim(),
    p_day_count: input.dayCount,
    p_court_count: input.courtCount,
    p_start_date: input.startDate,
    p_categories: payload as never,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function inviteStaff(
  email: string,
  role: "admin" | "registrar" | "scorer" | "scheduler",
) {
  const { error } = await supabase
    .from("staff_roles")
    .insert({ email: email.trim().toLowerCase(), role });
  if (error) throw new Error(error.message);
}

export async function removeStaff(id: string) {
  const { error } = await supabase.from("staff_roles").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
