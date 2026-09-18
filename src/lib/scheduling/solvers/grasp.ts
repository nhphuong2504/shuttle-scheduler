/**
 * Generic GRASP solver: a resource-driven constructive search over an event-driven clock.
 *
 * The timestamp is processed **before** it is advanced, so anything already feasible at the
 * horizon is never skipped. At each timestamp the resources are swept repeatedly until a complete
 * sweep makes zero assignments, because an assignment can free a resource, satisfy a zero-duration
 * dependency, or complete a participant's rest, and only a fresh sweep sees it.
 *
 * Participant eligibility is the bidirectional relation `relateToDecided(...) !== "conflict"`
 * against every decided occupancy of every participant, so a candidate that fits **before** a
 * later fixed match or anchor is eligible now rather than blocked until after it. There is no
 * per-participant free-time scalar: it cannot express a candidate's own `restBeforeMinutes`, and it
 * cannot express the `before` direction at all.
 */

import {
  buildIndexes,
  cloneDecidedByParticipant,
  cloneDecidedByResource,
  participantGate,
  resourceMeetsRequirements,
  validateSolution,
  type DecidedOccupancy,
  type SchedulingIndexes,
} from "../constraints";
import {
  compareIds,
  completionKeyOf,
  MINUTE_MS,
  requiredRestBetween,
  type Assignment,
  type ScheduleMatch,
  type SchedulingProblem,
  type Solution,
  type SolverTraceEntry,
} from "../domain";
import {
  buildSolution,
  compareMetrics,
  metricsOf,
  objectiveOrderOf,
  type SolutionMetrics,
} from "../metrics";
import { fitsInWindows } from "../time";
import {
  dependenciesSatisfied,
  describeDeadlock,
  durationMsOf,
  hasDecidedParticipants,
  lowerBoundOf,
  recordAssignment,
  uniqueParticipants,
} from "./shared";
import {
  DEFAULT_FRAGMENTATION_GAP_MINUTES,
  DEFAULT_RCL_SIZE,
  DEFAULT_RUNS,
  DEFAULT_SEED,
  defaultMaxIterations,
  mulberry32,
  type Solver,
  type SolverRunOptions,
} from "./types";

interface PlayerConstraint {
  playerId: string;
  remainingMatches: number;
  remainingGroupCount: number;
  futureConflictDegree: number;
  fixedWindowPressure: number;
}

interface MatchPriority {
  constrainedPlayer: PlayerConstraint;
  waitingTimeMinutes: number;
  phase: number;
  completionPressure: number;
  softOrder: number;
  sequence: number;
  matchId: string;
}

interface Ranked {
  match: ScheduleMatch;
  priority: MatchPriority;
}

interface RunOutcome {
  seed: number;
  assignments: Assignment[];
  unscheduled: string[];
  deadlockReason: string | null;
  trace: SolverTraceEntry[];
}

/** Descending constraint: the most constrained participant first. */
function comparePlayerConstraint(a: PlayerConstraint, b: PlayerConstraint): number {
  return (
    b.remainingMatches - a.remainingMatches ||
    b.remainingGroupCount - a.remainingGroupCount ||
    b.futureConflictDegree - a.futureConflictDegree ||
    b.fixedWindowPressure - a.fixedWindowPressure ||
    compareIds(a.playerId, b.playerId)
  );
}

function compareRanked(a: Ranked, b: Ranked): number {
  const ap = a.priority;
  const bp = b.priority;
  return (
    comparePlayerConstraint(ap.constrainedPlayer, bp.constrainedPlayer) ||
    bp.waitingTimeMinutes - ap.waitingTimeMinutes ||
    ap.phase - bp.phase ||
    ap.completionPressure - bp.completionPressure ||
    ap.softOrder - bp.softOrder ||
    ap.sequence - bp.sequence ||
    compareIds(ap.matchId, bp.matchId)
  );
}

function playerConstraint(
  playerId: string,
  currentTime: number,
  remaining: ReadonlySet<string>,
  remainingByParticipant: ReadonlyMap<string, number>,
  indexes: SchedulingIndexes,
  problem: SchedulingProblem,
): PlayerConstraint {
  const remainingIds = (indexes.matchesByPlayer.get(playerId) ?? []).filter((id) =>
    remaining.has(id),
  );
  const groups = new Set<string>();
  let futureConflictDegree = 0;
  let requiredMs = 0;

  for (const matchId of remainingIds) {
    const match = indexes.matchById.get(matchId);
    if (!match) continue;
    groups.add(match.groupKey);
    const participants = uniqueParticipants(match);
    for (const otherPlayerId of participants) {
      if (otherPlayerId === playerId) continue;
      const otherRemaining = remainingByParticipant.get(otherPlayerId) ?? 0;
      if (otherRemaining > 1) futureConflictDegree += otherRemaining - 1;
    }
    requiredMs += durationMsOf(match) + (match.restAfterMinutes ?? 0) * MINUTE_MS;
  }

  const availableMinutes = Math.max(0, problem.planningEnd - currentTime) / MINUTE_MS;
  const requiredMinutes = requiredMs / MINUTE_MS;
  return {
    playerId,
    remainingMatches: remainingIds.length,
    remainingGroupCount: groups.size,
    futureConflictDegree,
    fixedWindowPressure: Math.max(0, requiredMinutes - availableMinutes),
  };
}

function priorityFor(
  match: ScheduleMatch,
  currentTime: number,
  remaining: ReadonlySet<string>,
  remainingByParticipant: ReadonlyMap<string, number>,
  remainingByCompletionKey: ReadonlyMap<string, number>,
  constraintCache: Map<string, PlayerConstraint>,
  indexes: SchedulingIndexes,
  problem: SchedulingProblem,
  scheduledEnd: ReadonlyMap<string, number>,
): MatchPriority {
  const participants = uniqueParticipants(match);
  let constrainedPlayer: PlayerConstraint | null = null;
  for (const playerId of participants) {
    let constraint = constraintCache.get(playerId);
    if (!constraint) {
      constraint = playerConstraint(
        playerId,
        currentTime,
        remaining,
        remainingByParticipant,
        indexes,
        problem,
      );
      constraintCache.set(playerId, constraint);
    }
    if (constrainedPlayer == null || comparePlayerConstraint(constraint, constrainedPlayer) < 0) {
      constrainedPlayer = constraint;
    }
  }
  const fallback: PlayerConstraint = {
    playerId: "",
    remainingMatches: 0,
    remainingGroupCount: 0,
    futureConflictDegree: 0,
    fixedWindowPressure: 0,
  };
  const earliest = lowerBoundOf(match, indexes, scheduledEnd);
  return {
    constrainedPlayer: constrainedPlayer ?? fallback,
    waitingTimeMinutes: Math.max(0, (currentTime - earliest) / MINUTE_MS),
    phase: match.phase ?? 0,
    completionPressure: remainingByCompletionKey.get(completionKeyOf(match)) ?? 0,
    softOrder: match.softOrder ?? 0,
    sequence: match.sequence ?? 0,
    matchId: match.id,
  };
}

/** Everything that makes a match placeable on one resource at one instant. */
function isEligible(
  indexes: SchedulingIndexes,
  match: ScheduleMatch,
  resourceId: string,
  currentTime: number,
  remaining: ReadonlySet<string>,
  decidedByParticipant: ReadonlyMap<string, readonly DecidedOccupancy[]>,
  decidedByResource: ReadonlyMap<string, readonly DecidedOccupancy[]>,
  scheduledEnd: ReadonlyMap<string, number>,
): boolean {
  if (!remaining.has(match.id)) return false;
  const problem = indexes.problem;
  const durationMs = durationMsOf(match);
  const hardEnd = problem.hardEnd ?? null;

  if (currentTime < problem.floor) return false;
  if (match.eligibleFrom != null && match.eligibleFrom > currentTime) return false;
  if (hardEnd != null && currentTime + durationMs > hardEnd) return false;
  if (!dependenciesSatisfied(match, indexes, scheduledEnd, currentTime)) return false;

  const resource = indexes.resourceById.get(resourceId);
  if (!resource || !resourceMeetsRequirements(match, resource)) return false;
  const windows = indexes.openByResource.get(resourceId) ?? [];
  if (!fitsInWindows(currentTime, durationMs, windows)) return false;

  const occupancies = decidedByResource.get(resourceId);
  if (occupancies) {
    const end = currentTime + durationMs;
    for (const occupancy of occupancies) {
      if (currentTime < occupancy.end && occupancy.start < end) return false;
    }
  }

  const failure = participantGate(
    match,
    currentTime,
    uniqueParticipants(match),
    decidedByParticipant,
    match.id,
  );
  return failure == null;
}

/**
 * The next timestamp strictly after `currentTime` at which something could become feasible.
 *
 * Only the `after` direction contributes timestamps: the `before` direction is a start-time test
 * evaluated against `currentTime` and constrains how early a candidate may go rather than how long
 * it must wait. Participant unlocks are enumerated per `(decided occupancy, candidate, participant)`
 * triple, never as a per-participant scalar, because a candidate's own `restBeforeMinutes` can
 * exceed the decided occupancy's `restAfterMinutes` and a scalar would deadlock.
 *
 * An event is discarded only when `eventTime > hardEnd`, so `eventTime === hardEnd` is retained and
 * a zero-duration match may legally start exactly at the wall.
 */
function nextEvent(
  currentTime: number,
  remainingIds: readonly string[],
  indexes: SchedulingIndexes,
  decidedByParticipant: ReadonlyMap<string, readonly DecidedOccupancy[]>,
  decidedByResource: ReadonlyMap<string, readonly DecidedOccupancy[]>,
  scheduledEnd: ReadonlyMap<string, number>,
): number | null {
  const hardEnd = indexes.problem.hardEnd ?? null;
  let next = Number.POSITIVE_INFINITY;
  const consider = (value: number | undefined | null) => {
    if (value == null || !Number.isFinite(value)) return;
    if (value <= currentTime) return;
    if (hardEnd != null && value > hardEnd) return;
    if (value < next) next = value;
  };

  for (const occupancies of decidedByResource.values()) {
    for (const occupancy of occupancies) consider(occupancy.end);
  }
  for (const windows of indexes.openByResource.values()) {
    for (const window of windows) consider(window.start);
  }

  for (const matchId of remainingIds) {
    const match = indexes.matchById.get(matchId);
    if (!match) continue;
    consider(match.eligibleFrom);
    for (const dependencyId of match.dependencies ?? []) {
      const dependency = indexes.matchById.get(dependencyId);
      const end = scheduledEnd.get(dependencyId) ?? (dependency?.fixed ? dependency.end : undefined);
      consider(end ?? undefined);
    }
    for (const participantId of uniqueParticipants(match)) {
      const occupancies = decidedByParticipant.get(participantId);
      if (!occupancies) continue;
      for (const occupancy of occupancies) {
        consider(occupancy.end + requiredRestBetween(occupancy, match, participantId) * MINUTE_MS);
      }
    }
  }

  return Number.isFinite(next) ? next : null;
}

function runOnce(
  problem: SchedulingProblem,
  indexes: SchedulingIndexes,
  seed: number,
  rclSize: number,
  maxIterations: number,
  captureTrace: boolean,
): RunOutcome {
  const random = mulberry32(seed);
  const decidedByParticipant = cloneDecidedByParticipant(indexes.seedDecidedByParticipant);
  const decidedByResource = cloneDecidedByResource(indexes.seedDecidedByResource);

  const assignments: Assignment[] = [];
  const scheduledEnd = new Map<string, number>();
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
  const remaining = new Set<string>();
  const remainingByParticipant = new Map<string, number>();
  const remainingByCompletionKey = new Map<string, number>();

  for (const match of problem.matches) {
    if (match.fixed) continue;
    if (!hasDecidedParticipants(match)) {
      unscheduled.push(match.id);
      continue;
    }
    remaining.add(match.id);
    for (const participantId of uniqueParticipants(match)) {
      remainingByParticipant.set(participantId, (remainingByParticipant.get(participantId) ?? 0) + 1);
    }
    const key = completionKeyOf(match);
    remainingByCompletionKey.set(key, (remainingByCompletionKey.get(key) ?? 0) + 1);
  }

  const trace: SolverTraceEntry[] = [];
  let currentTime = problem.floor;
  let iterations = 0;
  let deadlockReason: string | null = null;
  const constraintCache = new Map<string, PlayerConstraint>();

  while (remaining.size > 0) {
    iterations++;
    if (iterations > maxIterations) {
      deadlockReason = `Iteration cap ${maxIterations} reached at ${new Date(currentTime).toISOString()}.`;
      break;
    }

    // ---- sweep the current timestamp to quiescence: at most one match per resource per sweep ----
    let assignedThisSweep = 0;
    do {
      assignedThisSweep = 0;
      for (const resource of indexes.resources) {
        // Eligibility is recomputed right here, so an assignment made earlier in this same
        // timestamp — on an earlier resource, or in an earlier sweep — is already visible.
        const ranked: Ranked[] = [];
        for (const matchId of [...remaining].sort(compareIds)) {
          const match = indexes.matchById.get(matchId);
          if (!match) continue;
          if (
            !isEligible(
              indexes,
              match,
              resource.id,
              currentTime,
              remaining,
              decidedByParticipant,
              decidedByResource,
              scheduledEnd,
            )
          ) {
            continue;
          }
          ranked.push({
            match,
            priority: priorityFor(
              match,
              currentTime,
              remaining,
              remainingByParticipant,
              remainingByCompletionKey,
              constraintCache,
              indexes,
              problem,
              scheduledEnd,
            ),
          });
        }
        if (!ranked.length) continue;

        ranked.sort(compareRanked);
        const rcl = ranked.slice(0, Math.min(rclSize, ranked.length));
        const selected = rcl[Math.floor(random() * rcl.length)] ?? rcl[0]!;

        const match = selected.match;
        const end = currentTime + durationMsOf(match);
        assignments.push({
          matchId: match.id,
          resourceId: resource.id,
          resourceOrder: resource.order,
          start: currentTime,
          end,
          groupKey: match.groupKey,
        });
        recordAssignment(
          match,
          resource.id,
          currentTime,
          end,
          uniqueParticipants(match),
          decidedByParticipant,
          decidedByResource,
        );
        scheduledEnd.set(match.id, end);
        remaining.delete(match.id);
        for (const participantId of uniqueParticipants(match)) {
          remainingByParticipant.set(
            participantId,
            Math.max(0, (remainingByParticipant.get(participantId) ?? 1) - 1),
          );
        }
        const key = completionKeyOf(match);
        remainingByCompletionKey.set(key, Math.max(0, (remainingByCompletionKey.get(key) ?? 1) - 1));
        constraintCache.clear();
        assignedThisSweep++;

        if (captureTrace) {
          trace.push({
            time: currentTime,
            event: "assign",
            matchId: match.id,
            resourceId: resource.id,
          });
        }
      }
    } while (assignedThisSweep > 0);

    if (remaining.size === 0) break;

    // ---- advance only once a complete sweep made zero assignments ----
    const next = nextEvent(
      currentTime,
      [...remaining].sort(compareIds),
      indexes,
      decidedByParticipant,
      decidedByResource,
      scheduledEnd,
    );
    if (next == null) {
      deadlockReason = describeDeadlock([...remaining].sort(compareIds), indexes, scheduledEnd);
      break;
    }
    currentTime = next;
  }

  for (const matchId of remaining) unscheduled.push(matchId);
  return {
    seed,
    assignments,
    unscheduled: unscheduled.sort(compareIds),
    deadlockReason,
    trace,
  };
}

function solveGrasp(problem: SchedulingProblem, options: SolverRunOptions): Solution {
  const indexes = buildIndexes(problem);
  const runs = Math.max(1, Math.floor(options.runs ?? DEFAULT_RUNS));
  const rclSize = Math.max(1, Math.floor(options.rclSize ?? DEFAULT_RCL_SIZE));
  const baseSeed = (options.seed ?? DEFAULT_SEED) >>> 0;
  const maxIterations = options.maxIterationsPerRun ?? defaultMaxIterations(problem);
  const fragmentationGapMinutes =
    options.fragmentationGapMinutes ?? DEFAULT_FRAGMENTATION_GAP_MINUTES;
  const captureTrace = options.debugTrace === true;

  let best: { solution: Solution; metrics: SolutionMetrics; seed: number } | null = null;

  const assemble = (outcome: RunOutcome): Solution =>
    buildSolution(problem, outcome.assignments, outcome.unscheduled, {
      solverId: graspSolver.id,
      runs,
      seed: outcome.seed,
      deadlockReason: outcome.deadlockReason,
      fragmentationGapMinutes,
      ...(captureTrace ? { trace: outcome.trace } : {}),
    });

  for (let run = 0; run < runs; run++) {
    const seed = (baseSeed + run) >>> 0;
    const outcome = runOnce(problem, indexes, seed, rclSize, maxIterations, captureTrace);
    const solution = assemble(outcome);
    // A run that violates a hard constraint is rejected outright rather than scored. The loop is
    // constructed to be valid, so this is a guard against a regression, not a routine path.
    if (validateSolution(problem, solution).length) continue;
    const metrics = metricsOf(problem, solution, fragmentationGapMinutes);
    const order = objectiveOrderOf(problem);
    if (
      best == null ||
      compareMetrics(metrics, best.metrics, order) < 0 ||
      (compareMetrics(metrics, best.metrics, order) === 0 && seed < best.seed)
    ) {
      best = { solution, metrics, seed };
    }
  }

  if (best) return best.solution;

  // No run produced a valid solution: report every non-fixed match as unscheduled rather than
  // returning something invalid.
  const fixedAssignments: Assignment[] = [];
  const fallbackUnscheduled: string[] = [];
  for (const match of problem.matches) {
    const resource =
      match.resourceId != null ? indexes.resourceById.get(match.resourceId) : undefined;
    if (match.fixed && resource && match.start != null && match.end != null) {
      fixedAssignments.push({
        matchId: match.id,
        resourceId: resource.id,
        resourceOrder: resource.order,
        start: match.start,
        end: match.end,
        groupKey: match.groupKey,
      });
    } else if (!match.fixed) {
      fallbackUnscheduled.push(match.id);
    }
  }
  return buildSolution(problem, fixedAssignments, fallbackUnscheduled.sort(compareIds), {
    solverId: graspSolver.id,
    runs,
    seed: baseSeed,
    deadlockReason: "No run produced a valid solution.",
    fragmentationGapMinutes,
  });
}

export const graspSolver: Solver = {
  id: "grasp",
  name: "GRASP",
  solve: solveGrasp,
};

export { isEligible, nextEvent, runOnce };
