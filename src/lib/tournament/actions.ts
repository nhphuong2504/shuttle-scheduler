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
import { gamesWinnerFor, isLegalGameScore, type GameScore } from "./format";
import { circleMethod, splitIntoPools } from "./pools";
import {
  registrationEntriesPayload,
  type RegistrationEntryInput,
} from "./registration";
import {
  gamesNeededToWin,
  isOddBestOf,
  scoringRuleLabel,
  type ScoringRule,
} from "./scoring";
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

/**
 * The working tournament, unless a caller already knows which one it means.
 *
 * Resolved through `current_tournament_id()`, which is the caller's own pointer. A
 * mutation must write into the caller's scope, never into whichever tournament some
 * other session happens to be showing.
 */
async function resolveTournamentId(explicit?: string | null): Promise<string | null> {
  if (explicit) return explicit;
  const { data, error } = await supabase.rpc("current_tournament_id");
  if (error) throw new Error(error.message);
  return data ?? null;
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

/**
 * Adds a person to the global player roster and returns the new id.
 *
 * Through `add_walk_in_player` rather than a table insert, and the return value is the reason.
 * PostgreSQL applies the table's **select** policy to `RETURNING`, and `players` deliberately
 * does not admit the row a client has just created: "you are this person, or a tournament they
 * entered", and a walk-in has no entry at that moment. A direct insert therefore had to return
 * nothing and leave the caller to find the person again in the roster - which no longer exists
 * as a readable whole. The function runs as definer, checks `can_add_walk_in_player()` itself,
 * and hands back the id, which `createTeam` can use straight away.
 */
export async function createPlayer(input: {
  name: string;
  email?: string;
  phone?: string;
  gender?: string;
}): Promise<string> {
  // `profile_id` is not accepted here, and could not be set if it were: the function has no such
  // parameter. A person's link is established by approving their registration request.
  const { data, error } = await supabase.rpc("add_walk_in_player", {
    p_name: input.name.trim(),
    ...(input.email?.trim() ? { p_email: input.email.trim() } : {}),
    ...(input.phone?.trim() ? { p_phone: input.phone.trim() } : {}),
    ...(input.gender ? { p_gender: input.gender } : {}),
  });
  if (error) throw new Error(error.message);
  return data as string;
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

/**
 * Refuses to save a result against a match that has changed since the dialog opened.
 *
 * The dialog holds a snapshot of the match. If another desk reported, reset or started it in the
 * meantime, "recorded" versus "corrected" and the not-started confirmation were decided against
 * stale state, and the save would silently overwrite the other desk's entry. The check is a
 * read just before the write, so it narrows that window to a round trip rather than closing it.
 *
 * `expectedReportedAt` is the second half: a *correction* leaves `status` at `reported`, so a
 * status-only check let two desks correcting the same result both pass, and the later save
 * overwrote the earlier one without either noticing. `reported_time` moves on every report, so
 * it distinguishes "nobody has touched this" from "someone corrected it while you were typing".
 * Omitted by callers that only care about the status (the restore paths), and compared whenever
 * it is supplied - including null, which is a match nobody has reported yet.
 */
export async function assertMatchUnchanged(
  table: "pool_matches" | "draw_matches" | "placement_matches" | "tier_draw_matches",
  matchId: string,
  expectedStatus: string,
  expectedReportedAt?: string | null,
): Promise<void> {
  const { data, error } = await supabase
    .from(table)
    .select("status, reported_time")
    .eq("id", matchId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("This match no longer exists.");
  if (data.status !== expectedStatus) {
    throw new Error(
      `This match changed to "${data.status}" while you were entering the result. Close this window and reopen the match to see the latest.`,
    );
  }
  if (expectedReportedAt !== undefined && (data.reported_time ?? null) !== expectedReportedAt) {
    throw new Error(
      "This result was changed while you were entering it. Close this window and reopen the match to see the latest.",
    );
  }
}

/**
 * A legacy group result.
 *
 * The rule stays the 21-point win-by-2 game because that is what `report_pool_result`
 * enforces in the database - the legacy pool engine was never made configurable, and a
 * tournament that plays its group matches to 15 does not change that table. What the desk
 * shows for a pool match is the same rule (`ruleFor("pool")` returns it), so this check is
 * the server's own bound restated, and the message now says it the way the RPC does.
 */
export async function reportPoolMatch(matchId: string, scoreA: number, scoreB: number) {
  if (!isLegalGameScore(scoreA, scoreB))
    throw new Error("Group games are race to 21, win by 2.");
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

/**
 * A legacy knockout result, under the rule the tournament actually configured.
 *
 * This used to read the games with `gamesWinner` - the pinned best-of-three to 21 - while the
 * dialog beside it drew its rows from the tournament's knockout rule and its refusal from
 * that same rule. A tournament playing best of five to 15 therefore had a dialog that
 * accepted a result and an action that refused it, and the refusal named a rule the operator
 * had never chosen. The server has read the tournament row since `20260916000000`, so the
 * client was the only side still pinned to the old constant.
 */
export async function reportDrawMatch(matchId: string, games: GameScore[], rule: ScoringRule) {
  const side = gamesWinnerFor(games, rule);
  if (!side) {
    const needed = gamesNeededToWin(rule);
    throw new Error(
      `Enter a winning result for ${scoringRuleLabel(rule)}: a side needs ${needed} game${needed === 1 ? "" : "s"}.`,
    );
  }
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
  /** The plan's own last finish: the latest end among matches it placed. */
  projectedFinish: string | null;
  currentProjectedFinish: string | null;
  projectedFinishDeltaMinutes: number | null;
  overrunMinutes: number;
  diagnostics?: SolverDiagnostics | undefined;
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
 * A direct table update rather than `save_tournament_config`, which deliberately
 * refuses anything that is not an UPCOMING row. Overriding mid-event is the point:
 * the desk finds out on the day that matches are running long, or that players
 * need longer between them, and must be able to replan without a new tournament.
 *
 * The bounds are enforced here rather than at the readiness gate. Readiness runs when
 * a tournament is started, before any of this is editable, so it can never see a live
 * override — these guards are the only thing standing between one and a schedule
 * built from a zero-minute match.
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
 * Overrides the scoring rules a reported result is validated against.
 *
 * Scoring used to be part of the setup wizard, which is the only reason it was
 * ever captured before the event. It sits beside the timings here because the two
 * are the same kind of setting — how a match is won and how long it is given —
 * and both are adjusted once the tournament is live and real scores come in.
 *
 * The bounds live here because readiness no longer checks them: it runs at
 * activation, long before scoring is editable, so a live override has nothing else
 * standing behind it.
 */
export interface TournamentMatchSettingsInput {
  placementGamesTo?: number;
  placementWinBy?: number;
  placementBestOf?: number;
  knockoutGamesTo?: number;
  knockoutWinBy?: number;
  knockoutBestOf?: number;
}

export async function updateTournamentMatchSettings(
  tournamentId: string,
  patch: TournamentMatchSettingsInput,
): Promise<void> {
  const payload: {
    placement_games_to?: number;
    placement_win_by?: number;
    placement_best_of?: number;
    knockout_games_to?: number;
    knockout_win_by?: number;
    knockout_best_of?: number;
  } = {};
  if (patch.placementGamesTo !== undefined) payload.placement_games_to = patch.placementGamesTo;
  if (patch.placementWinBy !== undefined) payload.placement_win_by = patch.placementWinBy;
  if (patch.placementBestOf !== undefined) payload.placement_best_of = patch.placementBestOf;
  if (patch.knockoutGamesTo !== undefined) payload.knockout_games_to = patch.knockoutGamesTo;
  if (patch.knockoutWinBy !== undefined) payload.knockout_win_by = patch.knockoutWinBy;
  if (patch.knockoutBestOf !== undefined) payload.knockout_best_of = patch.knockoutBestOf;
  if (!Object.keys(payload).length) return;

  for (const [key, value] of Object.entries(payload)) {
    if (key.endsWith("_best_of") && !isOddBestOf(value)) {
      throw new Error("A match is a single game or an odd best of 3, 5, 7 or 9.");
    }
    if (key.endsWith("_games_to") && (value < 1 || value > 99)) {
      throw new Error("A game is won at a score between 1 and 99.");
    }
    if (key.endsWith("_win_by") && (value < 1 || value > 20)) {
      throw new Error("The winning margin must be between 1 and 20.");
    }
  }

  const { error } = await supabase.from("tournaments").update(payload).eq("id", tournamentId);
  if (error) throw new Error(error.message);
}

/**
 * Sets how many courts the venue has, adding and removing `courts` rows to match.
 *
 * The pool is the venue's, not a day's: per-day assignments are made separately
 * and are left untouched here. Creating a court deliberately does not assign it to
 * a day, because a day with no assignment already means "every court".
 */
export async function setTournamentCourts(tournamentId: string, count: number): Promise<void> {
  const { error } = await supabase.rpc("set_tournament_courts", {
    p_tournament_id: tournamentId,
    p_count: count,
  });
  if (error) throw new Error(error.message);
}

/**
 * Adds a playing day to a tournament that is already under way.
 *
 * The date decides where the day lands: the database numbers it between its
 * neighbours, so `day_number` stays the order the rest of the app reads. The new day
 * starts on the 09:00–18:30 default and, having no per-day court rows, plays on
 * every court in the venue until it is narrowed on the Schedule page.
 *
 * Returns the new day's id, so the caller can highlight or scroll to it.
 */
export async function addTournamentDay(
  tournamentId: string,
  date: string,
  window?: { startTime?: string; endTime?: string },
): Promise<string> {
  const { data, error } = await supabase.rpc("add_tournament_day", {
    p_tournament_id: tournamentId,
    p_date: date,
    ...(window?.startTime ? { p_start_time: window.startTime } : {}),
    ...(window?.endTime ? { p_end_time: window.endTime } : {}),
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/**
 * Removes a playing day.
 *
 * The database refuses when it is the last day, or when anything is still scheduled
 * on it — a match's start time puts it on a day, so deleting the day underneath it
 * would silently move the match rather than fail. Those refusals arrive as the
 * thrown message, which is written to be shown to the host as-is.
 */
export async function removeTournamentDay(tournamentId: string, dayId: string): Promise<void> {
  const { error } = await supabase.rpc("remove_tournament_day", {
    p_tournament_id: tournamentId,
    p_day_id: dayId,
  });
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

// ---------------------------------------------------------------------------
// Tournament creation: atomic, and nothing is stored until it is complete
//
// A tournament is created in one call, with its window and its events, or it is not
// created. The wizard keeps the answers in the browser until then. There is no Draft
// row and no Start call: the first match started on the Desk is what moves a tournament
// to In Progress, and `completeTournament` is the only other transition.
//
// Every mutating RPC after creation re-checks the lifecycle itself, so a page left open
// across a start is refused by the database rather than silently writing to a live
// event.
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
  /**
   * The registration window, as ISO instants or null. Absent leaves the stored value
   * alone; an empty string clears it. Registration is optional in Phase 1 and there is
   * no UI for it, but the config payload carries it so Phase 2 does not need a new
   * write path.
   */
  registrationOpensAt?: string | null;
  registrationClosesAt?: string | null;
}

/**
 * Everything a tournament cannot exist without. `startsOn` and `endsOn` are the
 * tournament window: calendar dates in the venue's timezone, not instants. Playing days
 * are chosen later, inside the window, when the schedule is built.
 */
export interface NewTournamentInput extends TournamentDraftInput {
  startsOn: string;
  endsOn: string;
  events: TournamentEventInput[];
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
  registration_opens_at?: string;
  registration_closes_at?: string;
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
  // Sent as an empty string rather than omitted when explicitly cleared: the RPC reads
  // a present key as an instruction and an absent key as "leave it alone", so null has
  // to survive the JSON round-trip as something other than absence.
  if (input.registrationOpensAt !== undefined)
    payload.registration_opens_at = input.registrationOpensAt ?? "";
  if (input.registrationClosesAt !== undefined)
    payload.registration_closes_at = input.registrationClosesAt ?? "";
  return payload;
}

/**
 * Creates an upcoming tournament, complete, owned by the caller, and makes it their
 * working scope. All or nothing: a refusal leaves nothing behind.
 *
 * No role check beyond being signed in: anyone who signs up may run a tournament, and
 * the database is where that is enforced. The creator becomes the owner.
 */
export async function createTournament(input: NewTournamentInput): Promise<string> {
  const { data, error } = await supabase.rpc("create_tournament", {
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
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      ...(input.maxCategoriesPerPlayer !== undefined
        ? { max_categories_per_player: input.maxCategoriesPerPlayer }
        : {}),
      categories: eventsPayload(input.events),
      ...(input.registrationOpensAt && input.registrationClosesAt
        ? {
            registration_opens_at: input.registrationOpensAt,
            registration_closes_at: input.registrationClosesAt,
          }
        : {}),
    } as never,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/**
 * Moves the tournament window. The last date may move later until completion; the first
 * date is locked once the tournament is in progress. The database refuses a move that
 * would leave a playing day outside the window, or push the first date past the
 * registration deadline, and its message names the day.
 */
export async function updateTournamentWindow(
  tournamentId: string,
  startsOn: string,
  endsOn: string,
): Promise<void> {
  const { error } = await supabase.rpc("update_tournament_window", {
    p_tournament_id: tournamentId,
    p_starts_on: startsOn,
    p_ends_on: endsOn,
  });
  if (error) throw new Error(error.message);
}

/**
 * Sets the registration window: both instants, or both null to switch registration off.
 * "Close now" is `closes = now` with the same `opens`. The database enforces the rules -
 * it must close by 00:00 of the first window date, its opening time is fixed once passed,
 * and it cannot be extended once a schedule exists - and says which one was broken.
 */
export async function setRegistrationWindow(
  tournamentId: string,
  opensAt: string | null,
  closesAt: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("set_registration_window", {
    p_tournament_id: tournamentId,
    p_opens: opensAt as never,
    p_closes: closesAt as never,
  });
  if (error) throw new Error(error.message);
}

/**
 * Name, note, venue, address and organiser contact, until the tournament is completed.
 *
 * The narrow writer for what can still change once a tournament has started. It touches
 * nothing that alters a game: events, format, rules, window and timezone have their own
 * writers, and a payload key for any of them is ignored by the database rather than applied.
 */
export async function updateTournamentDetails(
  tournamentId: string,
  input: TournamentDraftInput,
): Promise<void> {
  const { error } = await supabase.rpc("update_tournament_details", {
    p_tournament_id: tournamentId,
    p_payload: draftBasicsPayload(input) as never,
  });
  if (error) throw new Error(error.message);
}

/**
 * Whether the server refuses to start a match when a player has not had their full rest.
 *
 * An on-the-day policy rather than a detail of the event: it is its own narrow writer
 * (`set_tournament_start_policy`), so it stays editable while the tournament plays even
 * though the setup wizard's configuration is frozen, and it is not part of the wizard's save.
 * The database guards it with `can_edit_tournament` and `assert_tournament_writable`, and
 * writes the single `block_start_on_short_rest` column and nothing else.
 */
export async function setTournamentStartPolicy(
  tournamentId: string,
  blockStartOnShortRest: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_tournament_start_policy", {
    p_tournament_id: tournamentId,
    p_block_start_on_short_rest: blockStartOnShortRest,
  });
  if (error) throw new Error(error.message);
}

/** What is left to play, for the Complete dialog. */
export interface CompletionCheck {
  /** Matches on court right now. Completing is refused while this is above zero. */
  onCourt: number;
  /** Matches that were scheduled and never played. Completing is allowed, with a warning. */
  unplayed: number;
  total: number;
}

export async function fetchCompletionCheck(tournamentId: string): Promise<CompletionCheck> {
  const { data, error } = await supabase.rpc("tournament_completion_check", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as { on_court?: number; unplayed?: number; total?: number };
  return {
    onCourt: row.on_court ?? 0,
    unplayed: row.unplayed ?? 0,
    total: row.total ?? 0,
  };
}

/**
 * Saves basics, the tournament-wide cap and the per-stage match rules.
 *
 * Upcoming only. The database refuses this from In Progress, and the refusal is the
 * point: a live tournament's rules must not change under matches already played.
 */
export async function saveTournamentConfig(
  tournamentId: string,
  input: TournamentDraftInput,
): Promise<void> {
  const { error } = await supabase.rpc("save_tournament_config", {
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

/** The event list as the database reads it. Shared by creation and by an edit. */
function eventsPayload(events: TournamentEventInput[]) {
  return events.map((event, index) => ({
    code: event.code,
    name: event.name,
    entry_type: event.entryType,
    gender: event.gender,
    sort_order: event.sortOrder ?? index + 1,
    active: event.active ?? true,
    max_entries: event.maxEntries ?? null,
  }));
}

/** Replaces the event list. Only an upcoming tournament with no entries may be rewritten. */
export async function saveTournamentEvents(
  tournamentId: string,
  events: TournamentEventInput[],
): Promise<void> {
  const { error } = await supabase.rpc("save_tournament_categories", {
    p_tournament_id: tournamentId,
    p_categories: eventsPayload(events) as never,
  });
  if (error) throw new Error(error.message);
}

/**
 * In Progress -> Completed. Terminal, except for a platform admin's repair path.
 *
 * Refused while a match is on court. Unplayed matches do not block it; the dialog warns
 * about them first (see `fetchCompletionCheck`).
 */
export async function completeTournament(tournamentId: string): Promise<void> {
  const { error } = await supabase.rpc("complete_tournament", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Points *this user* at a tournament. Nothing global changes.
 *
 * This is what an ordinary user does when they want to work somewhere else, and it is
 * available to anyone signed in: choosing your own view is not a privilege.
 */
export async function setCurrentTournament(tournamentId: string): Promise<void> {
  const { error } = await supabase.rpc("set_current_tournament", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Discards an upcoming tournament and everything it owns.
 *
 * Refuses anything that is not upcoming, which is exactly what protects a start-line
 * mistake: an event that has been started cannot be discarded, only completed or
 * deleted outright. The refusal is the database's, not this function's.
 */
export async function discardTournament(tournamentId: string): Promise<void> {
  const { error } = await supabase.rpc("discard_tournament", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Removes a tournament of any status, including the one in progress, along with
 * everything it owns. Permanent and not reversible. Owner or platform admin only.
 *
 * Kept separate from `discardTournament`, which refuses to touch anything that has
 * started: that refusal is what keeps the wizard's "Discard" button safe. This is the
 * explicitly destructive path.
 */
export async function deleteTournament(tournamentId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_tournament", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Grants one person edit rights on one tournament.
 *
 * By email rather than by user id, because the thing the host has is a list of
 * colleagues' addresses. The database resolves it to a profile and refuses an address
 * that has never signed in - an unlinked membership would sit inert and then activate
 * the day somebody else signed up with that address.
 *
 * Owner or platform admin only.
 */
export async function addTournamentEditor(tournamentId: string, email: string): Promise<string> {
  const { data, error } = await supabase.rpc("add_tournament_editor", {
    p_tournament_id: tournamentId,
    p_email: email.trim().toLowerCase(),
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/**
 * Revokes one person's edit rights. Owner or platform admin only.
 *
 * Takes a *profile* id, because membership is held by a person rather than an auth
 * identity - the roster returns profile ids, and passing anything else would delete
 * nothing and look like it had.
 *
 * The database refuses to remove the owner through this path: ownership transfer is
 * Phase 2, and allowing it here would leave a tournament nobody owns.
 */
export async function removeTournamentEditor(
  tournamentId: string,
  profileId: string,
): Promise<void> {
  const { error } = await supabase.rpc("remove_tournament_editor", {
    p_tournament_id: tournamentId,
    p_profile_id: profileId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Files - or replaces - this caller's registration request for one tournament.
 *
 * No client-side gate, on purpose. The RPC consults the lifecycle, the window, readiness, the
 * per-player event cap, each event's own state and the partner shape inside one transaction,
 * and every refusal carries the sentence the person should read ("That event is not open for
 * registration", "This tournament allows at most 2 event(s) per player"). A pre-check here
 * could only replace one of those with a vaguer one, or disagree with it - so the form is
 * rendered from `tournament_registration_state`, and the refusal is surfaced as it arrives.
 *
 * Idempotent by construction: a retry on bad wifi returns the same request rather than
 * filing a second one, which is the reason the RPC upserts rather than inserts.
 */
export async function submitTournamentRegistration(
  tournamentId: string,
  entries: readonly RegistrationEntryInput[],
): Promise<string> {
  const { data, error } = await supabase.rpc("submit_tournament_registration", {
    p_tournament_id: tournamentId,
    p_entries: registrationEntriesPayload(entries) as never,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("The registration request could not be filed.");
  return data as string;
}

/**
 * Withdraws this caller's own unanswered request.
 *
 * The requester's act and nobody else's - it is not editor-gated, because deleting your own
 * unanswered request is not a decision about the tournament. The RPC refuses another
 * person's request and one that has already been decided, and deletes the request and its
 * entries and nothing else: the approval is the only path that creates an entry, so
 * withdrawing cannot destroy competition data.
 */
export async function withdrawTournamentRegistration(registrationId: string): Promise<void> {
  const { error } = await supabase.rpc("withdraw_tournament_registration", {
    p_registration_id: registrationId,
  });
  if (error) throw new Error(error.message);
}

/** One reviewer decision, and the note that travels with it. */
export interface RegistrationDecisionInput {
  registrationId: string;
  decision: "approved" | "rejected";
  /** Optional for both outcomes; the reason an "approved" needed one is equally real. */
  note?: string | null;
}

/**
 * Approves or declines one waiting request.
 *
 * Approval is the only path that creates competition data - the linked requester's `players`
 * row, the unlinked partner's, and the `teams` entries - so it is editor-gated at the database
 * and it is the one act this page performs that changes what the tournament holds. A decline
 * creates nothing and takes nothing away, which is why the two share one call rather than two:
 * the RPC takes the decision word and does the shape difference, and the client does not
 * pre-judge which branch applies.
 *
 * No client-side gate, on the same reasoning as submission: the RPC re-checks that the caller
 * may edit, that the request is still pending, and that every category it names is not already
 * full - and its refusal names the event that was full, which is the sentence the reviewer
 * needs. A pre-check here could only replace that with a vaguer one, or disagree with it. The
 * note is trimmed to null when blank rather than stored as whitespace.
 */
export async function decideTournamentRegistration(
  input: RegistrationDecisionInput,
): Promise<void> {
  const note = input.note?.trim();
  const { error } = await supabase.rpc("decide_tournament_registration", {
    p_registration_id: input.registrationId,
    p_decision: input.decision,
    // Omitted rather than sent as null: the generated signature is `p_note?: string`, and an
    // absent key is the same to the function as a null one.
    ...(note ? { p_note: note } : {}),
  });
  if (error) throw new Error(error.message);
}
