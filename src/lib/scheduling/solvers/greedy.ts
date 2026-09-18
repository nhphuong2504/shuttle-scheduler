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
  completionKeyOf,
  forbiddenStartInterval,
  type Assignment,
  type ScheduleMatch,
  type SchedulingProblem,
  type Solution,
} from "../domain";
import { buildSolution } from "../metrics";
import { nextWindowStartAtOrAfter } from "../time";
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
import type { Solver, SolverRunOptions } from "./types";

/** Bounds the gap search so a pathological input degrades instead of spinning. */
const MAX_GAP_STEPS = 100_000;

/**
 * Process order: completion pressure (largest unit first, so a unit drains before the next one
 * starts), then soft order, phase, sequence and finally the id comparator.
 */
function processingOrder(problem: SchedulingProblem): ScheduleMatch[] {
  const pressure = new Map<string, number>();
  for (const match of problem.matches) {
    if (match.fixed) continue;
    const key = completionKeyOf(match);
    pressure.set(key, (pressure.get(key) ?? 0) + 1);
  }
  return problem.matches
    .filter((match) => !match.fixed)
    .slice()
    .sort(
      (a, b) =>
        (pressure.get(completionKeyOf(b)) ?? 0) - (pressure.get(completionKeyOf(a)) ?? 0) ||
        (a.softOrder ?? 0) - (b.softOrder ?? 0) ||
        (a.phase ?? 0) - (b.phase ?? 0) ||
        (a.sequence ?? 0) - (b.sequence ?? 0) ||
        compareIds(a.id, b.id),
    );
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
  let start = lowerBound;

  for (let step = 0; step < MAX_GAP_STEPS; step++) {
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
  const order = processingOrder(problem);
  const placeable: ScheduleMatch[] = [];
  for (const match of order) {
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
    let placedThisPass = 0;
    const next: ScheduleMatch[] = [];
    for (const match of pending) {
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
