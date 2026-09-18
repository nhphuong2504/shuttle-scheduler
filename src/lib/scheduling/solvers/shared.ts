/**
 * Pieces both solvers share: the seam that turns a solved problem into a `Solution`, the
 * dependency gate, and the deterministic explanation of why a run stopped early.
 */

import {
  addDecidedOccupancy,
  type DecidedByParticipant,
  type DecidedOccupancy,
  type SchedulingIndexes,
} from "../constraints";
import { compareIds, MINUTE_MS, type ScheduleMatch } from "../domain";

/** The end of a match if it has one: a fixed match's own end, or a scheduled assignment's. */
export function knownEndOf(
  matchId: string,
  indexes: SchedulingIndexes,
  scheduledEnd: ReadonlyMap<string, number>,
): number | null {
  const scheduled = scheduledEnd.get(matchId);
  if (scheduled != null) return scheduled;
  const match = indexes.matchById.get(matchId);
  if (match?.fixed && match.end != null) return match.end;
  // An anchor is decided history too: a match may depend on one, and a carried slot from an
  // earlier day is only ever represented this way because its court no longer applies.
  const anchor = indexes.anchorById.get(matchId);
  if (anchor) return anchor.end;
  return null;
}

/** True when every dependency has a known end at or before `start`. */
export function dependenciesSatisfied(
  match: ScheduleMatch,
  indexes: SchedulingIndexes,
  scheduledEnd: ReadonlyMap<string, number>,
  start: number,
): boolean {
  for (const dependencyId of match.dependencies ?? []) {
    const end = knownEndOf(dependencyId, indexes, scheduledEnd);
    if (end == null || end > start) return false;
  }
  return true;
}

/** True when every dependency has a known end, whatever it is. Used to order greedy attempts. */
export function allDependenciesKnown(
  match: ScheduleMatch,
  indexes: SchedulingIndexes,
  scheduledEnd: ReadonlyMap<string, number>,
): boolean {
  for (const dependencyId of match.dependencies ?? []) {
    if (knownEndOf(dependencyId, indexes, scheduledEnd) == null) return false;
  }
  return true;
}

/** The earliest a match may start, ignoring resources and participants. */
export function lowerBoundOf(
  match: ScheduleMatch,
  indexes: SchedulingIndexes,
  scheduledEnd: ReadonlyMap<string, number>,
): number {
  let bound = Math.max(indexes.problem.floor, match.eligibleFrom ?? indexes.problem.floor);
  for (const dependencyId of match.dependencies ?? []) {
    const end = knownEndOf(dependencyId, indexes, scheduledEnd);
    if (end != null) bound = Math.max(bound, end);
  }
  return bound;
}

/** Builds the decided-occupancy record for a solver-made assignment. */
export function occupancyOfAssignment(
  match: ScheduleMatch,
  resourceId: string,
  start: number,
  end: number,
): DecidedOccupancy {
  return {
    id: match.id,
    matchId: match.id,
    start,
    end,
    resourceId,
    restAfterMinutes: match.restAfterMinutes,
    restBeforeMinutes: match.restBeforeMinutes,
    restOverrides: match.restOverrides,
    fixedMatch: false,
  };
}

/** Records a solver-made assignment into the run-local decided indexes. */
export function recordAssignment(
  match: ScheduleMatch,
  resourceId: string,
  start: number,
  end: number,
  participantIds: readonly string[],
  decidedByParticipant: DecidedByParticipant,
  decidedByResource: Map<string, DecidedOccupancy[]>,
): DecidedOccupancy {
  const occupancy = occupancyOfAssignment(match, resourceId, start, end);
  addDecidedOccupancy(occupancy, participantIds, decidedByParticipant, decidedByResource);
  return occupancy;
}

/** The unique participant ids of a match, in compareIds order for determinism. */
export function uniqueParticipants(match: ScheduleMatch): string[] {
  return [...new Set(match.participantIds)].sort(compareIds);
}

/** True when a match can be placed at all: it has decided participants. */
export function hasDecidedParticipants(match: ScheduleMatch): boolean {
  return match.participantsKnown !== false && match.participantIds.length > 0;
}

/**
 * Why no future moment can make what is left eligible. A prerequisite that is neither scheduled
 * nor waiting in this run will never start however long the clock runs, and naming the pair is what
 * makes the next one of those diagnosable. Everything else is deliberately not blamed on capacity,
 * because a dependency cycle reaches here too and the two need opposite responses.
 */
export function describeDeadlock(
  remainingIds: readonly string[],
  indexes: SchedulingIndexes,
  scheduledEnd: ReadonlyMap<string, number>,
): string {
  const remaining = new Set(remainingIds);
  const orphaned: string[] = [];
  for (const matchId of [...remaining].sort(compareIds)) {
    const match = indexes.matchById.get(matchId);
    if (!match) continue;
    const missing = (match.dependencies ?? []).find(
      (dependencyId) => knownEndOf(dependencyId, indexes, scheduledEnd) == null && !remaining.has(dependencyId),
    );
    if (missing != null) orphaned.push(`${matchId} waits on ${missing}`);
  }
  if (orphaned.length) {
    return `Stuck: ${orphaned.join("; ")}. Nothing in this run schedules that prerequisite.`;
  }
  return `${remaining.size} match(es) are waiting, but no resource, participant or prerequisite frees anything up.`;
}

/** Duration in milliseconds. The one place a match's minutes become instants. */
export function durationMsOf(match: ScheduleMatch): number {
  return match.durationMinutes * MINUTE_MS;
}
