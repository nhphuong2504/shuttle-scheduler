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
import { alignUp, fitsInWindows } from "../time";
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
import {
  buildUrgencyBoard,
  compareUrgency,
  urgencyKeysOf,
  type UrgencyBoard,
  type UrgencyKeys,
} from "./urgency";

interface Ranked {
  match: ScheduleMatch;
  keys: UrgencyKeys;
}

interface RunOutcome {
  seed: number;
  assignments: Assignment[];
  unscheduled: string[];
  deadlockReason: string | null;
  trace: SolverTraceEntry[];
}

/**
 * Ranking one candidate at one instant is entirely `urgency.ts`'s job now.
 *
 * GRASP's contribution is the *input*: it sweeps a clock, so its window pressure shrinks and its
 * waiting time grows, and its "still unplaced" set is the live one. Greedy has no clock and supplies
 * the problem floor instead. One comparator over one tuple is what stops "the solver prefers X" from
 * meaning two different things depending on which strategy happens to win the fold.
 */
function rankKeysFor(
  match: ScheduleMatch,
  board: UrgencyBoard,
  indexes: SchedulingIndexes,
  scheduledEnd: ReadonlyMap<string, number>,
  currentTime: number,
): UrgencyKeys {
  const earliest = lowerBoundOf(match, indexes, scheduledEnd);
  return urgencyKeysOf(match, board, Math.max(0, (currentTime - earliest) / MINUTE_MS));
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
  const granularity = indexes.problem.startGranularityMs;
  let next = Number.POSITIVE_INFINITY;
  const consider = (raw: number | undefined | null) => {
    if (raw == null || !Number.isFinite(raw)) return;
    // On the grid, a match can only start at the next multiple at or after the moment it becomes
    // possible. `currentTime` is always on the grid, so anything later than it rounds to at least
    // one step on and the run cannot stall.
    const value = alignUp(raw, granularity);
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

  for (const match of problem.matches) {
    if (match.fixed) continue;
    if (!hasDecidedParticipants(match)) {
      unscheduled.push(match.id);
      continue;
    }
    remaining.add(match.id);
  }

  const trace: SolverTraceEntry[] = [];
  let currentTime = alignUp(problem.floor, problem.startGranularityMs);
  let iterations = 0;
  let deadlockReason: string | null = null;

  while (remaining.size > 0) {
    iterations++;
    if (iterations > maxIterations) {
      deadlockReason = `Iteration cap ${maxIterations} reached at ${new Date(currentTime).toISOString()}.`;
      break;
    }

    /**
     * The urgency board for this instant, rebuilt from the live unplaced set.
     *
     * Once per timestamp rather than once per sweep: `currentTime` is fixed while the sweep runs to
     * quiescence, so a board built here is the right input for every ranking at this instant, and
     * rebuilding per assignment would pay the whole participant scan again for nothing. That it is
     * rebuilt at all is the point — `stageRemaining` and `completionPressure` have to fall as the run
     * drains a stage, or the stage tier would keep voting for a stage that is already finished.
     */
    const board = buildUrgencyBoard({
      remaining: [...remaining]
        .sort(compareIds)
        .map((matchId) => indexes.matchById.get(matchId))
        .filter((match): match is ScheduleMatch => match != null),
      planningEnd: problem.planningEnd,
      referenceTime: currentTime,
    });

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
            keys: rankKeysFor(match, board, indexes, scheduledEnd, currentTime),
          });
        }
        if (!ranked.length) continue;

        ranked.sort((a, b) => compareUrgency(a.keys, b.keys));
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

/**
 * A scored candidate: the assembled solution, the objective inputs, and the run that produced it.
 * Metrics are carried alongside the solution so a fold never recomputes them for a loser.
 */
export interface SolverCandidate {
  solution: Solution;
  metrics: SolutionMetrics;
  seed: number;
}

/** Everything one GRASP search needs besides the problem. */
export interface GraspSearchOptions {
  /** Reported as `diagnostics.solverId`. A hybrid reports its own id, not GRASP's. */
  solverId: string;
  runs: number;
  rclSize: number;
  maxIterations: number;
  fragmentationGapMinutes: number;
  captureTrace: boolean;
}

/** The seed of run 0. Run `n` uses `baseSeed + n`, so a run range is a contiguous seed block. */
export function baseSeedOf(options: SolverRunOptions): number {
  return (options.seed ?? DEFAULT_SEED) >>> 0;
}

/**
 * Resolves `SolverRunOptions` into the concrete search parameters.
 *
 * `runsFallback` is per-strategy because the two strategies want different defaults: plain GRASP
 * still spends 75 runs, while the hybrid's greedy incumbent already covers what those runs buy and
 * needs only one. Sharing the fold while keeping separate run budgets is the point of this seam.
 */
export function graspSearchOptions(
  problem: SchedulingProblem,
  options: SolverRunOptions,
  solverId: string,
  runsFallback: number = DEFAULT_RUNS,
): GraspSearchOptions {
  return {
    solverId,
    runs: Math.max(1, Math.floor(options.runs ?? runsFallback)),
    rclSize: Math.max(1, Math.floor(options.rclSize ?? DEFAULT_RCL_SIZE)),
    maxIterations: options.maxIterationsPerRun ?? defaultMaxIterations(problem),
    fragmentationGapMinutes: options.fragmentationGapMinutes ?? DEFAULT_FRAGMENTATION_GAP_MINUTES,
    captureTrace: options.debugTrace === true,
  };
}

/**
 * Runs `search.runs` GRASP constructions and folds each valid candidate into `incumbent` by the
 * problem's lexicographic objective. This is the one place a GRASP run is scored, so plain GRASP and
 * the greedy-seeded hybrid cannot drift apart on how they compare candidates.
 *
 * A run that violates a hard constraint is rejected rather than scored; the loop is constructed to
 * be valid, so that is a guard against a regression, not a routine path. `preferOnTie` decides
 * equal-scoring candidates, which is the only thing the two strategies do differently: GRASP breaks
 * ties by seed, while a hybrid keeps the incumbent it already holds.
 */
export function searchGrasp(
  problem: SchedulingProblem,
  search: GraspSearchOptions,
  baseSeed: number,
  incumbent: SolverCandidate | null,
  preferOnTie: (candidate: SolverCandidate, incumbent: SolverCandidate) => boolean,
): SolverCandidate | null {
  const indexes = buildIndexes(problem);
  const order = objectiveOrderOf(problem);
  let best = incumbent;

  for (let run = 0; run < search.runs; run++) {
    const seed = (baseSeed + run) >>> 0;
    const outcome = runOnce(
      problem,
      indexes,
      seed,
      search.rclSize,
      search.maxIterations,
      search.captureTrace,
    );
    const solution = buildSolution(problem, outcome.assignments, outcome.unscheduled, {
      solverId: search.solverId,
      runs: search.runs,
      seed: outcome.seed,
      deadlockReason: outcome.deadlockReason,
      fragmentationGapMinutes: search.fragmentationGapMinutes,
      ...(search.captureTrace ? { trace: outcome.trace } : {}),
    });
    if (validateSolution(problem, solution).length) continue;

    const candidate: SolverCandidate = {
      solution,
      metrics: metricsOf(problem, solution, search.fragmentationGapMinutes),
      seed,
    };
    if (best == null) {
      best = candidate;
      continue;
    }
    const comparison = compareMetrics(candidate.metrics, best.metrics, order);
    if (comparison < 0 || (comparison === 0 && preferOnTie(candidate, best))) best = candidate;
  }

  return best;
}

/**
 * The last resort when nothing valid was produced: report the fixed matches and mark every
 * non-fixed match unscheduled, rather than returning something that violates a hard constraint.
 */
export function unplacedFallback(
  problem: SchedulingProblem,
  search: GraspSearchOptions,
  seed: number,
): Solution {
  const indexes = buildIndexes(problem);
  const fixedAssignments: Assignment[] = [];
  const unscheduled: string[] = [];
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
      unscheduled.push(match.id);
    }
  }
  return buildSolution(problem, fixedAssignments, unscheduled.sort(compareIds), {
    solverId: search.solverId,
    runs: search.runs,
    seed,
    deadlockReason: "No run produced a valid solution.",
    fragmentationGapMinutes: search.fragmentationGapMinutes,
  });
}

function solveGrasp(problem: SchedulingProblem, options: SolverRunOptions): Solution {
  const search = graspSearchOptions(problem, options, graspSolver.id);
  const baseSeed = baseSeedOf(options);
  const best = searchGrasp(
    problem,
    search,
    baseSeed,
    null,
    (candidate, incumbent) => candidate.seed < incumbent.seed,
  );
  return best?.solution ?? unplacedFallback(problem, search, baseSeed);
}

export const graspSolver: Solver = {
  id: "grasp",
  name: "GRASP",
  solve: solveGrasp,
};

export { isEligible, nextEvent, runOnce };
