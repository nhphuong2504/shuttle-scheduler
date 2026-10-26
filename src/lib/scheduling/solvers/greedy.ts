/**
 * Generic greedy solver.
 *
 * Processes matches in a deterministic order and, for each, runs a **gap search** over the
 * candidate resources: it advances `start` only to real boundaries (a conflict's forbidden-interval
 * `hi`, a resource occupancy end, an availability window start) and rejects candidates that
 * conflict under `relateToDecided`, overhang availability, or exceed `start + durationMinutes <=
 * hardEnd`. Advancing only to real boundaries is what lets a match land **before** a later fixed
 * match or anchor when that gap is large enough; a forward-only "earliest after every predecessor"
 * scan cannot do this.
 *
 * Deterministic: no randomness, every scan and tie goes through the canonical comparators.
 */

import {
  buildIndexes,
  cloneDecidedByParticipant,
  cloneDecidedByResource,
  participantGate,
  resourceMeetsRequirements,
  type DecidedByParticipant,
  type DecidedOccupancy,
  type SchedulingIndexes,
} from "../constraints";
import {
  compareIds,
  forbiddenStartInterval,
  type Assignment,
  type ScheduleMatch,
  type SchedulingProblem,
  type Solution,
} from "../domain";
import { buildSolution } from "../metrics";
import { alignUp, nextWindowStartAtOrAfter } from "../time";
import {
  allDependenciesKnown,
  dependenciesSatisfied,
  describeDeadlock,
  durationMsOf,
  hasDecidedParticipants,
  lowerBoundOf,
  recordAssignment,
  uniqueParticipants,
} from "./shared";
import { buildUrgencyBoard, rankByUrgency } from "./urgency";
import type { Solver, SolverRunOptions } from "./types";

/** Bounds the gap search so a pathological input degrades instead of spinning. */
const MAX_GAP_STEPS = 100_000;

/**
 * Process order: the one shared urgency order, recomputed for each dependency pass.
 *
 * Recomputed rather than computed once because `stageRemaining` and `completionPressure` count what
 * is *still* unplaced. A single snapshot taken from the whole problem would keep voting for a stage
 * that has already drained — the opposite of what the stage tier exists for.
 *
 * Greedy has no clock, so waiting time is a tie at 0 and the window is measured from the problem
 * floor. That is an input difference, not a different order: the comparator is the shared one.
 */
function processingOrder(
  problem: SchedulingProblem,
  pending: readonly ScheduleMatch[] = problem.matches.filter((match) => !match.fixed),
): ScheduleMatch[] {
  const board = buildUrgencyBoard({
    remaining: pending,
    planningEnd: problem.planningEnd,
    referenceTime: problem.floor,
  });
  return rankByUrgency(pending, board);
}

function firstOverlap(
  occupancies: readonly DecidedOccupancy[] | undefined,
  start: number,
  end: number,
): DecidedOccupancy | null {
  if (!occupancies) return null;
  for (const occupancy of occupancies) {
    if (start < occupancy.end && occupancy.start < end) return occupancy;
  }
  return null;
}

/**
 * The earliest start of `match` on one resource, or null when the resource can never host it.
 * Every advance is to a real boundary, and the participant gate is the only rest gate.
 */
function earliestStartOnResource(
  indexes: SchedulingIndexes,
  match: ScheduleMatch,
  resourceId: string,
  lowerBound: number,
  decidedByParticipant: ReadonlyMap<string, readonly DecidedOccupancy[]>,
  decidedByResource: ReadonlyMap<string, readonly DecidedOccupancy[]>,
  participants: readonly string[],
): number | null {
  const durationMs = durationMsOf(match);
  const windows = indexes.openByResource.get(resourceId) ?? [];
  const hardEnd = indexes.problem.hardEnd ?? null;
  const occupancies = decidedByResource.get(resourceId);
  const granularity = indexes.problem.startGranularityMs;
  let start = lowerBound;

  for (let step = 0; step < MAX_GAP_STEPS; step++) {
    // Every advance below lands on a real boundary, which may be any millisecond; the grid is
    // re-applied before each check so the start returned is always on it.
    start = alignUp(start, granularity);
    if (hardEnd != null && start + durationMs > hardEnd) return null;

    const windowStart = nextWindowStartAtOrAfter(start, durationMs, windows);
    if (windowStart == null) return null;
    if (windowStart > start) {
      start = windowStart;
      continue;
    }

    const blocking = firstOverlap(occupancies, start, start + durationMs);
    if (blocking) {
      start = Math.max(blocking.end, start + 1);
      continue;
    }

    const failure = participantGate(match, start, participants, decidedByParticipant, match.id);
    if (failure) {
      // A conflict means `start` is strictly inside the forbidden interval, so the `before` side is
      // already unavailable and `hi` is the next legal boundary.
      const { hi } = forbiddenStartInterval(match, failure.decided, failure.participantId);
      if (!(hi > start)) return null;
      start = hi;
      continue;
    }

    return start;
  }
  return null;
}

function solveGreedy(problem: SchedulingProblem, options: SolverRunOptions): Solution {
  const indexes = buildIndexes(problem);
  const decidedByParticipant = cloneDecidedByParticipant(indexes.seedDecidedByParticipant);
  const decidedByResource = cloneDecidedByResource(indexes.seedDecidedByResource);

  const assignments: Assignment[] = [];
  const scheduledEnd = new Map<string, number>();

  // Fixed matches are mandatory and immovable: they seed both the output and the decided state.
  for (const match of problem.matches) {
    if (!match.fixed) continue;
    const resource =
      match.resourceId != null ? indexes.resourceById.get(match.resourceId) : undefined;
    if (resource == null || match.start == null || match.end == null) continue;
    assignments.push({
      matchId: match.id,
      resourceId: resource.id,
      resourceOrder: resource.order,
      start: match.start,
      end: match.end,
      groupKey: match.groupKey,
    });
    scheduledEnd.set(match.id, match.end);
  }

  const unscheduled: string[] = [];
  const placeable: ScheduleMatch[] = [];
  for (const match of problem.matches) {
    if (match.fixed) continue;
    if (!hasDecidedParticipants(match)) unscheduled.push(match.id);
    else placeable.push(match);
  }

  const tryPlace = (match: ScheduleMatch): boolean => {
    const lowerBound = lowerBoundOf(match, indexes, scheduledEnd);
    const participants = uniqueParticipants(match);
    let best: { resourceId: string; resourceOrder: number; start: number } | null = null;

    for (const resource of indexes.resources) {
      if (!resourceMeetsRequirements(match, resource)) continue;
      const start = earliestStartOnResource(
        indexes,
        match,
        resource.id,
        lowerBound,
        decidedByParticipant,
        decidedByResource,
        participants,
      );
      if (start == null) continue;
      if (best == null || start < best.start) {
        best = { resourceId: resource.id, resourceOrder: resource.order, start };
      }
    }

    if (best == null) return false;
    const end = best.start + durationMsOf(match);
    assignments.push({
      matchId: match.id,
      resourceId: best.resourceId,
      resourceOrder: best.resourceOrder,
      start: best.start,
      end,
      groupKey: match.groupKey,
    });
    recordAssignment(
      match,
      best.resourceId,
      best.start,
      end,
      participants,
      decidedByParticipant,
      decidedByResource,
    );
    scheduledEnd.set(match.id, end);
    return true;
  };

  // Dependency-respecting passes: a match is only attempted once every feeder has a known end, so
  // chains resolve in order and a cycle places nothing.
  let pending = placeable;
  while (pending.length) {
    // Re-ranked from what is still unplaced, so the stage and completion tiers shrink as the run
    // drains them instead of being a fixed snapshot of the whole problem.
    const ordered = processingOrder(problem, pending);
    let placedThisPass = 0;
    const next: ScheduleMatch[] = [];
    for (const match of ordered) {
      if (!allDependenciesKnown(match, indexes, scheduledEnd)) {
        next.push(match);
        continue;
      }
      if (tryPlace(match)) placedThisPass++;
      else next.push(match);
    }
    if (placedThisPass === 0) break;
    pending = next;
  }
  for (const match of pending) unscheduled.push(match.id);

  const deadlockReason = pending.length
    ? describeDeadlock(
        pending.map((match) => match.id),
        indexes,
        scheduledEnd,
      )
    : null;

  return buildSolution(problem, assignments, unscheduled.sort(compareIds), {
    solverId: greedySolver.id,
    runs: 1,
    seed: options.seed ?? 0,
    deadlockReason,
    fragmentationGapMinutes:
      options.fragmentationGapMinutes ?? 30,
  });
}

export const greedySolver: Solver = {
  id: "greedy",
  name: "Greedy",
  solve: solveGreedy,
};

/** Exposed for tests that want the gap search without the registry. */
export { earliestStartOnResource, processingOrder };
