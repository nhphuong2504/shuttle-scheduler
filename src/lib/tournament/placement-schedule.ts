/**
 * Day planning for the two-round placement format.
 *
 * This is the placement format's counterpart to `planDay` in `actions.ts`, and it
 * exists as a separate module for the same reason the tables are separate: the
 * legacy planner reads `pool_matches` and `draw_matches` by name, and teaching it
 * about a second pair of tables would mean a function that has to know which
 * format it is looking at.
 *
 * What is shared is deliberate and narrow: the GRASP scheduler, the greedy
 * scheduler, the plan diff and the summary shape are all imported rather than
 * reimplemented. Only the row-to-match conversion and the persistence call are
 * format-specific, which is where the two formats genuinely differ.
 *
 * Two conversions are worth calling out:
 *
 *   * A placement match carries two *entrant* ids, and an entrant points at a
 *     team. Player ids therefore need an extra hop that the legacy tables do not.
 *     Getting this wrong would not fail loudly; the scheduler would just see a
 *     match with no players and mark it awaiting teams.
 *   * `placement_matches.prerequisite_ids` is the held entrant's ordering rule
 *     ("my second make-up waits for my first"). It maps straight onto the
 *     scheduler's `dependsOn`, which is what makes the held entrant's two matches
 *     sequential rather than simultaneous.
 */

import { supabase } from "@/integrations/supabase/client";

import type { ScheduleSummary, DayOneSchedulerOptions } from "./actions";
import type {
  Court,
  PlacementEntrant,
  PlacementMatch,
  PlacementStageName,
  Team,
  TierDraw,
  TierDrawMatch,
  Tournament,
  TournamentDay,
} from "./data";
import {
  diffPlan,
  projectedFinishFromRemainingMatches,
  type SchedulePlanDiff,
} from "./schedule-diff";
import { scheduleMatches, type SchedulableMatch, type ScheduledSlot } from "./scheduler";
import {
  scheduleGroupStageGrasp,
  type GraspScheduleResult,
  type GraspSchedulableMatch,
} from "./scheduler-grasp";

const MINUTE = 60_000;

export interface PlacementDayPlan {
  day: number;
  stage: PlacementStageName;
  tournamentId: string;
  slots: ScheduledSlot[];
  fixedMatchIds: string[];
  blocked: string[];
  awaitingTeams: string[];
  diff: SchedulePlanDiff;
  summary: ScheduleSummary;
  /**
   * Only slots that are allowed to move. Fixed matches are omitted, which is what
   * makes the persistence call a rebuild rather than a rewrite: the RPC clears and
   * re-sets only rows still in `scheduled`.
   */
  movableSlotPayload: { match_id: string; scheduled_time: string; court_id: string }[];
}

// ---------------------------------------------------------------------------
// Row-to-match conversion
// ---------------------------------------------------------------------------

/**
 * Resolves entrant ids to player ids through the entrant's team.
 *
 * Entrants that are still unknown (a knockout match whose parents have not been
 * decided) are reported as not known, not as an error: that match simply is not
 * schedulable yet.
 */
function buildPlayerLookup(
  entrants: readonly PlacementEntrant[],
  teams: readonly Team[],
): (entrantIds: readonly (string | null)[]) => {
  playerIds: string[];
  playersKnown: boolean;
} {
  const teamIdByEntrant = new Map(entrants.map((entrant) => [entrant.id, entrant.team_id]));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  return (entrantIds) => {
    const playerIds: string[] = [];
    let playersKnown = true;
    for (const entrantId of entrantIds) {
      const teamId = entrantId ? teamIdByEntrant.get(entrantId) : undefined;
      const team = teamId ? teamById.get(teamId) : undefined;
      if (!team) {
        // A missing side is "not yet decided" for a knockout, and a data problem
        // for a placement match. Both are handled the same way: the match is not
        // schedulable, and it surfaces as awaiting teams rather than as a silent
        // match with one player.
        playersKnown = false;
        continue;
      }
      playerIds.push(team.player_1_id);
      if (team.player_2_id) playerIds.push(team.player_2_id);
    }
    return { playerIds, playersKnown };
  };
}

function combineDateTime(date: string, time: string): Date {
  const normalized = time.length === 5 ? `${time}:00` : time;
  return new Date(`${date}T${normalized}`);
}

/** A match has a real result, so its time is an anchor rather than a suggestion. */
function isFixed(status: string): boolean {
  return status === "reported" || status === "in-progress" || status === "walkover";
}

function anchorStart(scheduledTime: string | null, startedAt: string | null): number | undefined {
  const anchor = startedAt ?? scheduledTime;
  return anchor ? new Date(anchor).getTime() : undefined;
}

/** The end a fixed match actually occupies, used to feed the next round. */
function plannedEndOf(
  status: string,
  endedAt: string | null,
  start: number | undefined,
  slotMinutes: number,
  floor: number,
  now: number,
): number | undefined {
  if (endedAt && (status === "reported" || status === "walkover")) {
    return new Date(endedAt).getTime();
  }
  const planned = start != null ? start + slotMinutes * MINUTE : undefined;
  // An in-progress match has no known end yet, so it is modelled as at least one
  // slot from now: leaving it at its planned end would let the scheduler place
  // the next match on that court before the running one has finished.
  if (status === "in-progress" && planned != null) {
    return Math.max(planned, floor + slotMinutes * MINUTE, now + slotMinutes * MINUTE);
  }
  return planned;
}

/**
 * Placement matches, in the shape the GRASP scheduler wants.
 *
 * `dependsOn` is filled from `prerequisite_ids`, but only for prerequisites that
 * are themselves in this batch. A prerequisite that is void or missing would
 * otherwise be a dependency the scheduler can never satisfy, which turns one
 * abandoned match into an unschedulable day — so it is dropped and the match is
 * left to the desk.
 */
function placementItems(input: {
  matches: readonly PlacementMatch[];
  playerLookup: (entrantIds: readonly (string | null)[]) => {
    playerIds: string[];
    playersKnown: boolean;
  };
  courtNumberById: ReadonlyMap<string, number>;
  categoryOrder: ReadonlyMap<string, number>;
  slotMinutes: number;
  floor: number;
  now: number;
}): GraspSchedulableMatch[] {
  const { matches, playerLookup, courtNumberById, categoryOrder, slotMinutes, floor, now } = input;
  // Non-void rows are the schedulable universe, and the set a prerequisite must
  // be a member of to be honoured.
  const inBatch = new Set(
    matches.filter((match) => match.status !== "void").map((match) => match.id),
  );

  return matches
    .filter((match) => match.status !== "void")
    .map((match) => {
      const { playerIds, playersKnown } = playerLookup([match.entrant_a_id, match.entrant_b_id]);
      const start = anchorStart(match.scheduled_time, match.started_at);
      const fixed = isFixed(match.status);
      return {
        id: match.id,
        categoryId: match.category_id,
        categoryOrder: categoryOrder.get(match.category_id) ?? 0,
        // No pool to complete: a placement category is its own completion unit,
        // so the scheduler's completion-pressure term falls back to the category.
        poolId: null,
        playerIds,
        playersKnown,
        kind: "group" as const,
        // Round one ranks before round two, but only as a late tie-break: GRASP
        // prioritises the most constrained player first. That is sufficient here
        // because round two is only generated once every round-one result is in,
        // so a round-one match is always a fixed anchor by the time a round-two
        // match is movable — and a fixed anchor constrains its players directly.
        // The two rounds cannot compete for the same court slot.
        order: match.stage === "round1" ? 1 : 2,
        round: match.stage === "round1" ? 1 : 2,
        dependsOn: match.prerequisite_ids.filter((id) => inBatch.has(id)),
        fixed,
        start,
        end: plannedEndOf(match.status, match.ended_at, start, slotMinutes, floor, now),
        courtNumber: match.court_id ? courtNumberById.get(match.court_id) : undefined,
      };
    });
}

/**
 * Tier-draw matches, in the shape the greedy scheduler wants.
 *
 * A match with an undecided side is dropped rather than listed as awaiting teams:
 * it is not a match yet, and including it would make every not-yet-reached round
 * show as a missing fixture. Byes are dropped for the same reason plus one more —
 * they are already decided and there is nothing to place.
 */
function tierItems(input: {
  matches: readonly TierDrawMatch[];
  drawCategory: ReadonlyMap<string, string>;
  playerLookup: (entrantIds: readonly (string | null)[]) => {
    playerIds: string[];
    playersKnown: boolean;
  };
  courtNumberById: ReadonlyMap<string, number>;
  categoryOrder: ReadonlyMap<string, number>;
  slotMinutes: number;
  restGap: number;
  floor: number;
  now: number;
}): SchedulableMatch[] {
  const { matches, drawCategory, playerLookup, courtNumberById, categoryOrder } = input;
  const { slotMinutes, restGap, floor, now } = input;

  // Indexed once: the parent lookup below would otherwise rescan `matches` for
  // every match, which is quadratic in a bracket that is already large.
  const byId = new Map(matches.map((match) => [match.id, match]));

  return matches
    .filter((match) => !match.is_bye && match.status !== "void")
    .map((match) => {
      const { playerIds, playersKnown } = playerLookup([match.entrant_a_id, match.entrant_b_id]);
      // A knockout match may not start until both of its feeders have finished,
      // plus the player rest gap — including when a feeder was decided by a bye
      // rather than played.
      const parentEnd = [match.parent_a_id, match.parent_b_id].reduce((acc, parentId) => {
        const parent = parentId ? byId.get(parentId) : undefined;
        const finished = parent?.ended_at ?? parent?.reported_time;
        return finished ? Math.max(acc, new Date(finished).getTime() + restGap * MINUTE) : acc;
      }, 0);
      const start = anchorStart(match.scheduled_time, match.started_at);
      const fixed = isFixed(match.status);
      const categoryId = drawCategory.get(match.draw_id) ?? match.draw_id;

      return {
        id: match.id,
        categoryId,
        categoryOrder: categoryOrder.get(categoryId) ?? 0,
        poolId: null,
        playerIds,
        playersKnown,
        kind: "knockout" as const,
        order: match.round * 100 + match.slot,
        earliestStart: parentEnd || undefined,
        fixed,
        start,
        end: plannedEndOf(match.status, match.ended_at, start, slotMinutes, floor, now),
        courtNumber: match.court_id ? courtNumberById.get(match.court_id) : undefined,
      };
    })
    .filter((item) => {
      // An already-reported match stays in the batch as an anchor. Anything else
      // needs two sides that have actually been decided: a knockout fixture waiting
      // on its bracket is not a match yet, and listing it would make every
      // not-yet-reached round look like something the desk has to chase.
      return item.fixed || item.playerIds.length > 0;
    });
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanPlacementDayInput {
  day: number;
  stage: PlacementStageName;
  tournament: Tournament;
  dayConfig: TournamentDay;
  courts: Court[];
  teams: Team[];
  entrants: PlacementEntrant[];
  draws: TierDraw[];
  placementMatches: PlacementMatch[];
  tierMatches: TierDrawMatch[];
  categoryOrder: Map<string, number>;
  options?: DayOneSchedulerOptions;
  /** Injectable clock, so a rebuild's floor is testable rather than wall-clock. */
  now?: number;
}

/**
 * Builds one day's plan for one stage, without writing anything.
 *
 * A stage's duration and rest gap come from the tournament's group and knockout
 * columns: the placement stage reuses the group columns rather than adding a third
 * pair, because it occupies the same slot in the day as the legacy group stage did.
 */
export function planPlacementDay(input: PlanPlacementDayInput): PlacementDayPlan {
  const {
    day,
    stage,
    tournament,
    dayConfig,
    courts,
    teams,
    entrants,
    draws,
    placementMatches,
    tierMatches,
    categoryOrder,
    options: graspOptions,
    now = Date.now(),
  } = input;

  if (!courts.length) throw new Error("Load the court list before building a schedule.");

  const isPlacement = stage === "placement";
  const slotMinutes = isPlacement
    ? tournament.group_slot_minutes
    : tournament.knockout_slot_minutes;
  const restGap = isPlacement
    ? tournament.group_rest_gap_minutes
    : tournament.knockout_rest_gap_minutes;

  const dayStart = combineDateTime(dayConfig.date, dayConfig.start_time);
  const planningEnd = combineDateTime(dayConfig.date, dayConfig.end_time);
  const playerLookup = buildPlayerLookup(entrants, teams);
  const courtNumberById = new Map(courts.map((court) => [court.id, court.number]));
  const drawCategory = new Map(draws.map((draw) => [draw.id, draw.category_id]));

  // A rebuild starts from now, never from the original day start: replanning a day
  // that is already under way must not put matches in the past. A first build
  // starts from the window instead, because nothing has happened yet and the host
  // picked that start time deliberately.
  const existing = isPlacement ? placementMatches : tierMatches;
  const isRebuild = existing.some(
    (match) => match.status !== "void" && match.scheduled_time != null,
  );
  const nextWholeMinute = Math.ceil(now / MINUTE) * MINUTE;
  const schedulingFloor = isRebuild
    ? new Date(Math.max(dayStart.getTime(), nextWholeMinute))
    : dayStart;

  const items: GraspSchedulableMatch[] = isPlacement
    ? placementItems({
        matches: placementMatches,
        playerLookup,
        courtNumberById,
        categoryOrder,
        slotMinutes,
        floor: schedulingFloor.getTime(),
        now,
      })
    : (tierItems({
        matches: tierMatches,
        drawCategory,
        playerLookup,
        courtNumberById,
        categoryOrder,
        slotMinutes,
        restGap,
        floor: schedulingFloor.getTime(),
        now,
      }) as GraspSchedulableMatch[]);

  const result = isPlacement
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
  const diff = diffPlan(existing, result.slots, fixedSet, courtNumberById);
  diff.unplaceable = blocked;

  const movableSlotPayload = result.slots
    .filter((slot) => !fixedSet.has(slot.matchId))
    .map((slot) => ({
      match_id: slot.matchId,
      scheduled_time: slot.start.toISOString(),
      court_id: slot.courtId,
    }));

  const graspResult = isPlacement ? (result as GraspScheduleResult) : null;
  // The finish the current schedule already implies, so the desk can be told
  // whether a rebuild actually moves the end of the day.
  const currentFinishMs = isRebuild
    ? projectedFinishFromRemainingMatches(existing, slotMinutes, now)
    : null;
  const newFinishMs = result.projectedFinish?.getTime() ?? null;
  const projectedFinishDeltaMinutes =
    currentFinishMs != null && newFinishMs != null
      ? Math.round((newFinishMs - currentFinishMs) / MINUTE)
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
    stage,
    tournamentId: tournament.id,
    slots: result.slots,
    fixedMatchIds,
    blocked,
    awaitingTeams,
    diff,
    summary,
    movableSlotPayload,
  };
}

/**
 * Splits what could not be placed into "the desk must intervene" and "this is not
 * a match yet".
 *
 * Mirrors the same distinction in `actions.ts`. A match with no players is a
 * knockout fixture waiting for its bracket, which is normal; a match with players
 * that the scheduler still could not fit is a real problem.
 */
function partitionUnscheduled(
  unscheduled: readonly string[],
  items: readonly GraspSchedulableMatch[],
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

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Writes a plan. Refuses to persist a plan that left a schedulable match out:
 * a half-built day is worse than no day, because a match with players and no court
 * looks like a fixture the desk forgot rather than one it never created.
 */
export async function applyPlacementDayPlan(plan: PlacementDayPlan): Promise<void> {
  if (plan.blocked.length > 0) {
    const reason = plan.summary.diagnostics?.deadlockReason;
    throw new Error(
      reason
        ? `Cannot apply rebuild: ${plan.blocked.length} match(es) could not be placed. ${reason}`
        : `Cannot apply rebuild: ${plan.blocked.length} match(es) could not be placed.`,
    );
  }
  const { error } = await supabase.rpc("apply_placement_day_schedule", {
    p_tournament_id: plan.tournamentId,
    p_stage: plan.stage,
    p_slots: plan.movableSlotPayload as never,
  });
  if (error) throw new Error(error.message);
}

/**
 * A human label for a match id, for the rebuild preview.
 *
 * The preview lists matches by id, and a raw uuid tells the desk nothing about
 * which fixture is moving — which is the one thing the preview exists to answer.
 */
export function placementMatchLabel(
  matchId: string,
  placementMatches: readonly PlacementMatch[],
  tierMatches: readonly TierDrawMatch[],
  labelForEntrant: (entrantId: string | null) => string,
): string {
  const placement = placementMatches.find((match) => match.id === matchId);
  if (placement) {
    return `${labelForEntrant(placement.entrant_a_id)} vs ${labelForEntrant(placement.entrant_b_id)}`;
  }
  const tier = tierMatches.find((match) => match.id === matchId);
  if (tier) {
    return `${labelForEntrant(tier.entrant_a_id)} vs ${labelForEntrant(tier.entrant_b_id)}`;
  }
  return matchId.slice(0, 8);
}

/** Exported for the stage selector, so the UI and the planner cannot disagree. */
export function placementStageLabel(stage: PlacementStageName): string {
  return stage === "placement" ? "placement" : "knockouts";
}
