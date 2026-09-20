/**
 * Day planning for the two-round placement format.
 *
 * This is the placement format's counterpart to `planDay` in `actions.ts`, and it
 * exists as a separate module for the same reason the tables are separate: the
 * legacy planner reads `pool_matches` and `draw_matches` by name, and teaching it
 * about a second pair of tables would mean a function that has to know which
 * format it is looking at.
 *
 * What is shared is deliberate and narrow: the scheduling core and day runner, the
 * row-to-item conversion, the plan diff and the summary shape are all imported rather
 * than reimplemented. The plan carries no finish forecast: the only finish it reports is
 * the last end among the matches it actually placed.
 *
 * Two conversions are worth calling out:
 *
 *   * A placement match carries two *entrant* ids, and an entrant points at a
 *     team. Player ids therefore need an extra hop that the legacy tables do not.
 *     Getting this wrong would not fail loudly; the scheduler would just see a
 *     match with no players and mark it awaiting teams.
 *   * `placement_matches.prerequisite_ids` is the held entrant's ordering rule
 *     ("my second make-up waits for my first"). It maps straight onto the
 *     scheduler's `dependencies`, which is what makes the held entrant's two matches
 *     sequential rather than simultaneous.
 */

import { supabase } from "@/integrations/supabase/client";

import type { ScheduleSummary } from "./actions";
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
  TournamentDayBreak,
} from "./data";
import { diffPlan, type SchedulePlanDiff } from "./schedule-diff";
import {
  breakWindowsFor,
  courtsForDay,
  dayWindowBounds,
  runPlanDays,
  sliceRowsByDay,
  type DaySlice,
  type PlacementDayFill,
} from "./scheduling/day-plan";
import type { DayOneSchedulerOptions } from "./scheduling/policy";
import {
  buildPlayerLookup,
  placementItems,
  tierItems,
  type StageItem,
} from "./scheduling/stage-items";
import type { ScheduledSlot } from "./scheduling/types";

const MINUTE = 60_000;

export {
  breakWindowsFor,
  courtsForDay,
  dayWindowBounds,
  sliceRowsByDay,
  type DaySlice,
  type PlacementDayFill,
  type StageItem,
};

export interface PlacementSlotPayload {
  match_id: string;
  scheduled_time: string;
  court_id: string;
}

/**
 * A whole tournament's schedule: every day, both stages, one queue.
 *
 * Fixed (reported, in-progress and walkover) matches are left out of the payloads,
 * which is what makes applying a plan a rebuild rather than a rewrite: the writer
 * clears and re-sets only rows still in `scheduled`.
 */
export interface PlacementSchedulePlan {
  tournamentId: string;
  /** Every slot in the plan, across every day and both stages. */
  slots: ScheduledSlot[];
  fixedMatchIds: string[];
  blocked: string[];
  awaitingTeams: string[];
  diff: SchedulePlanDiff;
  summary: ScheduleSummary;
  days: PlacementDayFill[];
  /**
   * Split by stage because the writer is stage-scoped: `apply_placement_day_schedule`
   * takes one stage and clears only that stage's rows. Keeping `p_stage` means one
   * plan becomes two calls rather than a migration to widen the RPC.
   */
  placementSlotPayload: PlacementSlotPayload[];
  knockoutSlotPayload: PlacementSlotPayload[];
  /**
   * The rows each stage's call will CLEAR, captured as the plan was computed.
   *
   * `apply_placement_day_schedule` wipes every `scheduled` row of its stage and then
   * re-sets whatever the payload names, so a row that is cleared and not named is
   * left with no court and no time — the RPC's own completeness guard then fails the
   * whole transaction. Carrying these ids lets the client check that invariant
   * before it sends anything, which turns "the rebuild left a match behind" into a
   * message that says which match and why.
   */
  placementScheduledIds: string[];
  knockoutScheduledIds: string[];
  /** Why the scheduler could not place something, for the desk-facing error. */
  blockedReason: string | null;
}

export interface PlanPlacementScheduleInput {
  tournament: Tournament;
  /** Every day. Order does not matter; they are sorted by day_number. */
  days: readonly TournamentDay[];
  /** The whole court pool. Each day narrows it through `dayCourtIds`. */
  allCourts: readonly Court[];
  /** Courts per day id. A day with no entry plays on every court. */
  dayCourtIds?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /** Breaks per day id. */
  breaksByDayId?: ReadonlyMap<string, readonly TournamentDayBreak[]> | undefined;
  teams: readonly Team[];
  entrants: readonly PlacementEntrant[];
  draws: readonly TierDraw[];
  placementMatches: readonly PlacementMatch[];
  tierMatches: readonly TierDrawMatch[];
  categoryOrder: ReadonlyMap<string, number>;
  options?: DayOneSchedulerOptions;
  /** Injectable clock, so a rebuild's floor is testable rather than wall-clock. */
  now?: number;
}

/**
 * Plans the whole tournament as one queue, without writing anything.
 *
 * The queue is the placement stage and then the knockouts. It fills each day in
 * turn — day one first, spilling into day two, and so on — so a day's stage mix is
 * an outcome rather than an input, and a day may carry the tail of one stage and
 * the head of the next.
 *
 * The stage barrier is real rather than advisory: the knockouts are only placed on
 * a day once every placement match has a slot. But it is also already guaranteed
 * by the generators, because round two cannot exist until every round one result
 * is in and a knockout round cannot exist until the previous one is decided. That
 * is why this needs no round-ordering logic of its own: scheduling everything that
 * exists is the same thing as scheduling in order.
 *
 * A stage's duration and rest gap come from the tournament's group and knockout
 * columns; the placement stage reuses the group columns rather than adding a third
 * pair, because it occupies the same slot in the day the legacy group stage did.
 */
export function planPlacementSchedule(input: PlanPlacementScheduleInput): PlacementSchedulePlan {
  const {
    tournament,
    days,
    allCourts,
    dayCourtIds,
    breaksByDayId,
    teams,
    entrants,
    draws,
    placementMatches,
    tierMatches,
    categoryOrder,
    options,
    now = Date.now(),
  } = input;

  if (!days.length) {
    throw new Error("A tournament needs at least one day before a schedule can be built.");
  }
  if (!allCourts.length) throw new Error("Load the court list before building a schedule.");

  const orderedDays = [...days].sort((a, b) => a.day_number - b.day_number);
  const nextWholeMinute = Math.ceil(now / MINUTE) * MINUTE;

  const placementSlot = tournament.group_slot_minutes;
  const placementRest = tournament.group_rest_gap_minutes;
  const knockoutSlot = tournament.knockout_slot_minutes;
  const knockoutRest = tournament.knockout_rest_gap_minutes;

  const playerLookup = buildPlayerLookup(entrants, teams);
  const courtNumberById = new Map(allCourts.map((court) => [court.id, court.number]));
  const drawCategory = new Map(draws.map((draw) => [draw.id, draw.category_id]));

  const existing = [...placementMatches, ...tierMatches];
  // One rebuild flag for the whole tournament, not per stage: a plan that has to
  // respect what has already been played must do so on every day it touches.
  const isRebuild = existing.some(
    (match) => match.status !== "void" && match.scheduled_time != null,
  );

  // Only used to model an in-progress match's end, because each day applies its own
  // floor at run time. The earliest plausible start keeps that model conservative.
  const firstDayStart = new Date(`${orderedDays[0]!.date}T${orderedDays[0]!.start_time}`).getTime();
  const itemFloor = isRebuild ? Math.max(firstDayStart, nextWholeMinute) : firstDayStart;

  // Round one and round two are one stage, so they share a duration and a queue
  // slot; the queue has two printers, not three.
  const placementAll = placementItems({
    matches: placementMatches,
    playerLookup,
    courtNumberById,
    categoryOrder,
    slotMinutes: placementSlot,
    restGap: placementRest,
    floor: itemFloor,
    now,
  });
  const knockoutAll = tierItems({
    matches: tierMatches,
    drawCategory,
    playerLookup,
    courtNumberById,
    categoryOrder,
    slotMinutes: knockoutSlot,
    restGap: knockoutRest,
    floor: itemFloor,
    now,
  });

  const run = runPlanDays({
    orderedDays,
    allCourts,
    ...(dayCourtIds ? { dayCourtIds } : {}),
    ...(breaksByDayId ? { breaksByDayId } : {}),
    placementAll,
    knockoutAll,
    placementSlotMinutes: placementSlot,
    placementRestGapMinutes: placementRest,
    knockoutSlotMinutes: knockoutSlot,
    knockoutRestGapMinutes: knockoutRest,
    isRebuild,
    nextWholeMinute,
    ...(options ? { options } : {}),
  });

  const everything = [...placementAll, ...knockoutAll];
  const fixedSet = new Set(everything.filter((item) => item.fixed).map((item) => item.id));
  const { blocked, awaitingTeams } = partitionUnscheduled(
    [...run.placementUnscheduled, ...run.knockoutUnscheduled],
    everything,
  );

  // Described from the final set rather than from whichever run stopped first. The
  // old wording was that run's: "No future event can make 1 remaining match(es)
  // eligible", which named a count that could disagree with the list printed under
  // it and never said what was actually wrong.
  const blockedReason = blocked.length
    ? explainBlocked(blocked, {
        items: everything,
        scheduledIds: new Set(run.allSlots.map((slot) => slot.matchId)),
        heldByPlacement:
          run.placementUnscheduled.length > 0 ? new Set(run.knockoutUnscheduled) : new Set(),
      })
    : null;

  const diff = diffPlan(existing, run.allSlots, fixedSet, courtNumberById);
  diff.unplaceable = blocked;

  const summary: ScheduleSummary = {
    placed: diff.placedCount,
    anchorCount: fixedSet.size,
    movedCount: diff.movedCount,
    unscheduled: blocked.length,
    awaitingTeams: awaitingTeams.length,
    utilization: run.totalCapacityMinutes > 0 ? run.usedMinutes / run.totalCapacityMinutes : 0,
    remainingUtilization: run.lastDiagnostics?.remainingWindowUtilization ?? null,
    // Lateness only. The unscheduled list is the incompleteness signal and carries it on its own,
    // so a day that closes on time but cannot place everything reports no overrun. Folding the two
    // together used to make an incomplete plan claim it ran past the day end.
    overrun: run.days.some((fill) => fill.overrunMinutes > 0),
    projectedFinish: run.lastFinishMs != null ? new Date(run.lastFinishMs).toISOString() : null,
    // The rebuild no longer compares two finishes: the plan's own last finish is the only
    // finish there is, and the per-day change table is what shows how the rebuild differs.
    currentProjectedFinish: null,
    projectedFinishDeltaMinutes: null,
    overrunMinutes:
      run.lastFinishMs != null && run.lastPlanningEndMs > 0
        ? Math.max(0, Math.round((run.lastFinishMs - run.lastPlanningEndMs) / MINUTE))
        : 0,
    ...(run.lastDiagnostics ? { diagnostics: run.lastDiagnostics } : {}),
  };

  const payloadFor = (stageIds: ReadonlySet<string>): PlacementSlotPayload[] =>
    run.allSlots
      .filter((slot) => stageIds.has(slot.matchId) && !fixedSet.has(slot.matchId))
      .map((slot) => ({
        match_id: slot.matchId,
        scheduled_time: slot.start.toISOString(),
        court_id: slot.courtId,
      }));

  // The rows the writer is about to clear, which the payloads above must therefore
  // cover. Byes and `void` rows are excluded because the RPC excludes them too.
  const placementScheduledIds = placementMatches
    .filter((match) => match.status === "scheduled")
    .map((match) => match.id);
  const knockoutScheduledIds = tierMatches
    .filter((match) => match.status === "scheduled" && !match.is_bye)
    .map((match) => match.id);

  return {
    tournamentId: tournament.id,
    slots: run.allSlots,
    fixedMatchIds: [...fixedSet],
    blocked,
    awaitingTeams,
    diff,
    summary,
    days: run.days,
    placementSlotPayload: payloadFor(new Set(placementAll.map((item) => item.id))),
    knockoutSlotPayload: payloadFor(new Set(knockoutAll.map((item) => item.id))),
    placementScheduledIds,
    knockoutScheduledIds,
    blockedReason,
  };
}

/**
 * The scheduled rows a plan would clear without re-setting.
 *
 * Non-empty means applying the plan would strip a match of its court and time, so
 * the writer must refuse rather than let the database guard fail the transaction
 * with no indication of which match was dropped. Rows `void` by the desk, and
 * knockout byes, are not counted because the writer never clears them.
 *
 * Exported and pure so the invariant is testable without a database.
 */
export function uncoveredScheduledMatches(plan: PlacementSchedulePlan): {
  placement: string[];
  knockout: string[];
} {
  const missingFor = (
    scheduledIds: readonly string[],
    payload: readonly PlacementSlotPayload[],
  ): string[] => {
    const covered = new Set(payload.map((slot) => slot.match_id));
    return scheduledIds.filter((id) => !covered.has(id));
  };
  return {
    placement: missingFor(plan.placementScheduledIds, plan.placementSlotPayload),
    knockout: missingFor(plan.knockoutScheduledIds, plan.knockoutSlotPayload),
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
  items: readonly StageItem[],
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

/**
 * What is wrong with the matches that could not be placed, in the cause-and-effect
 * order a desk needs to fix them.
 *
 * The old message was the first deadlocking run's: "No future event can make 1
 * remaining match(es) eligible". It named a count that could disagree with the list
 * printed under it, and never said what was wrong. Three causes reach here and they
 * need opposite responses — a prerequisite that is not scheduled at all, a knockout
 * held behind the placement stage, and a set that is waiting on itself — so each is
 * named.
 *
 * The first is a guard rather than a routine path: `placementItems` drops
 * prerequisites that are not in the batch precisely so one abandoned match cannot
 * make a day unschedulable. It is kept because the shape it describes is the one
 * this planner has actually failed in before — a prerequisite placed by an earlier
 * day was invisible to a later day's run — and a message that names it is what turns
 * the next one of those from an hour of guessing into an obvious answer.
 */
function explainBlocked(
  blocked: readonly string[],
  input: {
    items: readonly StageItem[];
    scheduledIds: ReadonlySet<string>;
    /** Knockouts still queued because the placement stage has not drained. */
    heldByPlacement: ReadonlySet<string>;
  },
): string {
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const blockedIds = new Set(blocked);
  const dependsOn = (id: string) => byId.get(id)?.dependencies ?? [];

  const orphaned = blocked.flatMap((id) =>
    dependsOn(id)
      .filter(
        (dependencyId) =>
          // Still waiting its own slot is not a cause: it is placed first. Neither
          // scheduled nor waiting means nothing in this plan will ever place it.
          !input.scheduledIds.has(dependencyId) && !blockedIds.has(dependencyId),
      )
      .map((dependencyId) => ({ id, dependencyId })),
  );
  const held = blocked.filter((id) => input.heldByPlacement.has(id));

  /**
   * Whether the placement stage is stuck with itself.
   *
   * It cannot drain for capacity reasons — the last day is allowed to overrun — so a
   * placement match that no day took is either missing a prerequisite or waiting on
   * one of its own. Knockouts are excluded: they carry no `dependencies` at all, their
   * ordering is the stage barrier, so they would read as "able to start" and mask it.
   */
  const placementStuck = blocked.filter((id) => !input.heldByPlacement.has(id));
  const mutual =
    placementStuck.length > 0 &&
    !placementStuck.some((id) =>
      dependsOn(id).every((dependencyId) => input.scheduledIds.has(dependencyId)),
    );

  const reasons: string[] = [];
  if (orphaned.length) {
    const distinct = [...new Set(orphaned.map((entry) => entry.id))];
    // The prerequisite is named because the list of blocked matches below names only
    // the match, never what it is waiting for.
    reasons.push(
      `${distinct.length} ${distinct.length === 1 ? "is" : "are"} waiting on a prerequisite that this plan never schedules (${orphaned[0]!.dependencyId})`,
    );
  } else if (mutual) {
    reasons.push(
      `${placementStuck.length} placement ${placementStuck.length === 1 ? "match is" : "matches are"} waiting on each other, so none of them can go first`,
    );
  }
  // Named after the cause, never before it: knockouts are only ever held because
  // placement did not drain, so leading with them would point at the symptom.
  if (held.length) {
    reasons.push(
      `${held.length} knockout ${held.length === 1 ? "match is" : "matches are"} held behind the placement stage`,
    );
  }
  if (reasons.length) return `${reasons.join(", and ")}.`;

  return "Each has every prerequisite placed, but no court and a free pair of players come free at the same time.";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Writes a whole plan. Refuses to persist one that left a schedulable match out: a
 * half-built schedule is worse than none, because a match with players and no court
 * looks like a fixture the desk forgot rather than one it never created.
 *
 * Two calls rather than one, because `apply_placement_day_schedule` is stage-scoped
 * and clears only its own stage's rows. Placement goes first so a failure part-way
 * leaves the earlier stage scheduled rather than the later one orphaned.
 *
 * The completeness check is repeated here against the plan's own `scheduled` rows
 * because the RPC's equivalent guard can only say that *some* row was dropped. When
 * the planner is handed an input it cannot read — an entrant list or team list that
 * has not loaded, say — every match looks like it is still waiting for its players,
 * `blocked` stays empty, and the payload comes out short. Catching it here names the
 * cause and leaves the database untouched, instead of letting the RPC clear the day
 * and then roll the whole thing back with "left assigned matches without a court or
 * time".
 */
export async function applyPlacementSchedulePlan(plan: PlacementSchedulePlan): Promise<void> {
  if (plan.blocked.length > 0) {
    throw new Error(
      plan.blockedReason
        ? `Cannot apply the schedule: ${plan.blocked.length} match(es) could not be placed. ${plan.blockedReason}`
        : `Cannot apply the schedule: ${plan.blocked.length} match(es) could not be placed.`,
    );
  }

  const uncovered = uncoveredScheduledMatches(plan);
  const dropped = [...uncovered.placement, ...uncovered.knockout];
  if (dropped.length > 0) {
    throw new Error(
      `Cannot apply the schedule: ${dropped.length} already-scheduled match(es) have no court or time in this plan. ` +
        `This means the planner could not read their players — reload the page and build again.`,
    );
  }

  const calls: [PlacementStageName, PlacementSlotPayload[]][] = [
    ["placement", plan.placementSlotPayload],
    ["knockout", plan.knockoutSlotPayload],
  ];
  for (const [stage, slots] of calls) {
    const { error } = await supabase.rpc("apply_placement_day_schedule", {
      p_tournament_id: plan.tournamentId,
      p_stage: stage,
      p_slots: slots as never,
    });
    if (error) throw new Error(error.message);
  }
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
