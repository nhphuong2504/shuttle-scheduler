/**
 * Metrics: the reporting family the desk reads and the optimization family the objective scores.
 *
 * One number cannot serve both purposes. Decided history — fixed matches and anchors — is real
 * time on the day, so the desk must see it, but it is not the solver's doing, so it must not
 * score a run. The two families are therefore computed separately and never mixed.
 *
 * Occupancy is measured as merged intervals per resource, so back-to-back matches count once and
 * gaps count against usage. All durations are minutes; all instants are epoch milliseconds.
 */

import {
  completionKeyOf,
  MINUTE_MS,
  requiredRestBetween,
  type Assignment,
  type ObjectiveCriterion,
  type ScheduleMatch,
  type SchedulingProblem,
  type Solution,
  type SolverDiagnostics,
  type SolverTraceEntry,
  type TimeWindow,
} from "./domain";
import { mergedOccupancyMinutes } from "./time";

/** Ordered highest priority first. Lower is better for every criterion. */
export const DEFAULT_OBJECTIVE_ORDER: readonly ObjectiveCriterion[] = [
  "unscheduled",
  "afterCutoff",
  "stageProgression",
  "makespan",
  "resourceIdle",
  "excessWait",
  "fragmentation",
  "softOrderDeviation",
  "disruption",
];

/**
 * What one court change costs the `disruption` criterion, in the same minutes as a start move.
 *
 * One slot by default, which is deliberately the same order as the movement it is being weighed
 * against: "moved ten minutes on the same court" and "same time on another court" should not be
 * priced wildly apart, and a court change is a real cost at the desk — a different court means a
 * different walk for the players and a different board for the moderator.
 */
export const DISRUPTION_COURT_CHANGE_MINUTES = 30;

export interface SolutionMetrics {
  /** `Solution.unscheduled.length`. Incompleteness. Separate from both lateness numbers. */
  unscheduled: number;
  /** Optimization lateness: exactly `Solution.decisionAfterCutoff`. Never the reporting lateness. */
  afterCutoff: number;
  /**
   * When the pipeline closes, weighted by what closing it releases. See `stageProgressionScore`.
   *
   * Above `makespan` deliberately: a stage that closes earlier releases the next stage, whereas a
   * shorter makespan only shortens the tail, and the two are not the same trade.
   */
  stageProgression: number;
  /** `Solution.decisionFinish - horizonStart`, or 0 when the solver placed nothing. */
  makespan: number;
  /** Exactly `Solution.decisionResourceIdle`. */
  resourceIdle: number;
  /**
   * Total participant excess wait, in minutes, over solver-created assignments only. For each
   * participant, sum `max(0, gap - requiredRestBetween)` over consecutive assignments in start
   * order. This is the legacy `totalExcessWait` term, not the max or the average.
   */
  excessWait: number;
  /**
   * Group fragmentation, ported from the legacy category fragmentation: group assignments by
   * `completionKeyOf(match)`, sort by start, start a new block whenever `start - blockEnd > gap`,
   * and sum `max(0, blocks - 1)` over all groups.
   */
  fragmentation: number;
  /**
   * Soft-order deviation, redefined post-hoc so every solver is scored on the same footing:
   * within each `groupKey`, count inversions of `sequence` in start order. A match with no
   * `sequence` contributes nothing. The legacy constructive number is not reproduced.
   */
  softOrderDeviation: number;
  /**
   * How far the rebuild moved what the desk was already looking at. See `disruptionScore`.
   *
   * Ordered last, below `softOrderDeviation`: it is a preference for leaving well enough alone, and
   * the tail of the schedule should still move whenever moving it materially improves stage
   * progression or the overall schedule. Zero on a first build and zero on a re-solve that agrees.
   */
  disruption: number;
}

/** -1 when `a` wins, 1 when `b` wins, 0 when every criterion ties. */
export function compareMetrics(
  a: SolutionMetrics,
  b: SolutionMetrics,
  order: readonly ObjectiveCriterion[] = DEFAULT_OBJECTIVE_ORDER,
): number {
  for (const criterion of order) {
    const delta = a[criterion] - b[criterion];
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

/** The problem's criteria order, defaulting to `DEFAULT_OBJECTIVE_ORDER`. */
export function objectiveOrderOf(problem: SchedulingProblem): readonly ObjectiveCriterion[] {
  const order = problem.objective;
  return order && order.length ? order : DEFAULT_OBJECTIVE_ORDER;
}

/** The ordered tuple the comparator reads, for diagnostics and tie reporting. */
export function metricsTuple(
  metrics: SolutionMetrics,
  order: readonly ObjectiveCriterion[],
): number[] {
  return order.map((criterion) => metrics[criterion]);
}

/**
 * The one bridge from a `Solution` to the optimization tuple, and the only thing `compareMetrics`
 * reads. It takes the problem because `makespan` needs `horizonStart` and `excessWait` /
 * `fragmentation` / `softOrderDeviation` need durations, rest and grouping keys, none of which are
 * recoverable from a `Solution` alone. Pure, and it never reads `solution.diagnostics`, so a
 * solver cannot inflate its own score.
 */
export function metricsOf(
  problem: SchedulingProblem,
  solution: Solution,
  fragmentationGapMinutes = 30,
): SolutionMetrics {
  const matchById = new Map(problem.matches.map((match) => [match.id, match]));

  return {
    unscheduled: solution.unscheduled.length,
    afterCutoff: solution.decisionAfterCutoff,
    stageProgression: stageProgressionScore(problem, solution.assignments),
    makespan:
      solution.decisionFinish == null
        ? 0
        : Math.max(0, Math.round((solution.decisionFinish - problem.horizonStart) / MINUTE_MS)),
    resourceIdle: solution.decisionResourceIdle,
    excessWait: participantWaitMetrics(
      matchById,
      solverAssignmentsOf(problem, solution.assignments),
    ).excessWait,
    fragmentation: groupFragmentation(matchById, solution.assignments, fragmentationGapMinutes),
    softOrderDeviation: softOrderInversions(matchById, solution.assignments),
    disruption: disruptionScore(problem, solution.assignments),
  };
}

/**
 * How far the solver moved what the desk was already looking at:
 * `Σ over baseline matches ( |Δstart| minutes + court-change penalty )`.
 *
 * Zero with no baseline, which is what a first build gets: there is nothing to disturb. Fixed
 * matches contribute nothing — they are pinned, so a solver that moved one would have failed
 * validation rather than scored badly.
 *
 * A baseline match the solution never places is skipped rather than charged, because no finite
 * penalty stands in for "it lost its slot entirely". That is safe rather than convenient: the
 * `unscheduled` criterion outranks this one, so a candidate that drops a match has already lost
 * before disruption is consulted, and this one can only ever separate candidates that placed the
 * same amount of work.
 */
export function disruptionScore(
  problem: SchedulingProblem,
  assignments: readonly Assignment[],
): number {
  const baseline = problem.baseline;
  if (!baseline || !baseline.length) return 0;

  const fixedIds = new Set(problem.matches.filter((match) => match.fixed).map((match) => match.id));
  const assignedById = new Map(assignments.map((assignment) => [assignment.matchId, assignment]));

  let total = 0;
  for (const slot of baseline) {
    if (fixedIds.has(slot.matchId)) continue;
    const assignment = assignedById.get(slot.matchId);
    if (!assignment) continue;
    total += Math.abs(assignment.start - slot.start) / MINUTE_MS;
    if (assignment.resourceId !== slot.resourceId) {
      total += DISRUPTION_COURT_CHANGE_MINUTES;
    }
  }
  return round3(total);
}

/** Solver-created (non-fixed) assignments only: decided history is never the solver's doing. */
function solverAssignmentsOf(
  problem: SchedulingProblem,
  assignments: readonly Assignment[],
): Assignment[] {
  const fixedIds = new Set(problem.matches.filter((match) => match.fixed).map((match) => match.id));
  return assignments.filter((assignment) => !fixedIds.has(assignment.matchId));
}

/** Per-participant wait figures over solver-created assignments only. */
export interface ParticipantWaitMetrics {
  /** Sum over participants of their total excess wait, in minutes. */
  excessWait: number;
  /** Smallest observed gap between consecutive assignments; null when nobody has two. */
  minimumRest: number | null;
  maximumExcessWait: number;
  averageExcessWait: number;
}

/**
 * Walks each participant's solver-created assignments in start order and measures the gap between
 * consecutive ones against the rest their two matches require.
 */
export function participantWaitMetrics(
  matchById: ReadonlyMap<string, ScheduleMatch>,
  assignments: readonly Assignment[],
): ParticipantWaitMetrics {
  const byParticipant = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    const match = matchById.get(assignment.matchId);
    if (!match) continue;
    for (const participantId of new Set(match.participantIds)) {
      const list = byParticipant.get(participantId) ?? [];
      list.push(assignment);
      byParticipant.set(participantId, list);
    }
  }

  let excessWait = 0;
  let minimumRest: number | null = null;
  let maximumExcessWait = 0;
  let averageExcessWait = 0;
  let participantsWithPairs = 0;

  for (const list of byParticipant.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.start - b.start || a.matchId.localeCompare(b.matchId));
    let participantExcess = 0;
    for (let i = 1; i < list.length; i++) {
      const previous = list[i - 1]!;
      const next = list[i]!;
      const previousMatch = matchById.get(previous.matchId);
      const nextMatch = matchById.get(next.matchId);
      if (!previousMatch || !nextMatch) continue;
      const participantId = [...previousMatch.participantIds].find((id) =>
        nextMatch.participantIds.includes(id),
      );
      if (participantId == null) continue;
      const required = requiredRestBetween(previousMatch, nextMatch, participantId);
      const gapMinutes = (next.start - previous.end) / MINUTE_MS;
      if (minimumRest == null || gapMinutes < minimumRest) minimumRest = gapMinutes;
      participantExcess += Math.max(0, gapMinutes - required);
    }
    excessWait += participantExcess;
    if (participantExcess > maximumExcessWait) maximumExcessWait = participantExcess;
    averageExcessWait += participantExcess;
    participantsWithPairs++;
  }

  return {
    excessWait: round3(excessWait),
    minimumRest: minimumRest == null ? null : round3(minimumRest),
    maximumExcessWait: round3(maximumExcessWait),
    averageExcessWait: participantsWithPairs
      ? round3(averageExcessWait / participantsWithPairs)
      : 0,
  };
}

/**
 * When the pipeline closes, stage by stage: `Σ over stages ( stageClose − horizonStart ) × weight`,
 * in minutes, where `stageClose` is the last end among that stage's assignments and the weight is
 * 2 for a stage that releases a later one and 1 otherwise.
 *
 * Lower is better. A stage that nearly finishes but keeps slipping is exactly what this prices: the
 * current slot is close to a stage boundary, and closing it is worth more than closing a stage that
 * has hours of work left. The unlock weight is the same boolean the urgency order reads, so ranking
 * and scoring cannot drift apart — a stage that gates the next one is worth twice as much here as
 * one that gates nothing.
 *
 * Two things it deliberately does *not* do. It reads every assignment, fixed history included,
 * rather than the solver's own: a stage really does close at an instant, and on a problem where the
 * history is identical between candidates the fixed contribution is a constant that cancels. And it
 * never reads `solution.diagnostics`, so a solver cannot inflate its own score.
 *
 * A stage the problem defines but the solution never placed closes at `planningEnd` rather than
 * being left out of the sum. Without that, the cheapest way to improve the score would be to drop a
 * whole stage — which is the one thing this metric exists to prevent.
 */
export function stageProgressionScore(
  problem: SchedulingProblem,
  assignments: readonly Assignment[],
): number {
  const matchById = new Map(problem.matches.map((match) => [match.id, match]));

  /** Every stage the problem declares, and whether closing it releases a later one. */
  const declared = new Map<string, boolean>();
  for (const match of problem.matches) {
    if (match.stageKey == null) continue;
    declared.set(
      match.stageKey,
      (declared.get(match.stageKey) ?? false) || match.stageUnlocks === true,
    );
  }

  /** The last end actually assigned in each stage. */
  const closeByStage = new Map<string, number>();
  for (const assignment of assignments) {
    const match = matchById.get(assignment.matchId);
    if (!match || match.stageKey == null) continue;
    const close = closeByStage.get(match.stageKey);
    if (close == null || assignment.end > close) closeByStage.set(match.stageKey, assignment.end);
  }

  let total = 0;
  for (const [stage, unlocks] of declared) {
    // A declared stage with no assignment never closed, so it is charged the end of the plan rather
    // than skipped: leaving it out would make dropping a whole stage the cheapest way to improve
    // the score, which is the one thing this metric exists to prevent.
    const close = closeByStage.get(stage) ?? problem.planningEnd;
    const minutes = Math.max(0, (close - problem.horizonStart) / MINUTE_MS);
    total += minutes * (unlocks ? 2 : 1);
  }
  return round3(total);
}

/**
 * Sums `max(0, blocks - 1)` over each completion key, where a new block starts whenever the gap
 * from the running block end exceeds `gapMinutes`.
 */
export function groupFragmentation(
  matchById: ReadonlyMap<string, ScheduleMatch>,
  assignments: readonly Assignment[],
  gapMinutes: number,
): number {
  const gapMs = gapMinutes * MINUTE_MS;
  const byGroup = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    const match = matchById.get(assignment.matchId);
    if (!match) continue;
    const key = completionKeyOf(match);
    const list = byGroup.get(key) ?? [];
    list.push(assignment);
    byGroup.set(key, list);
  }

  let fragmentation = 0;
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.start - b.start || a.matchId.localeCompare(b.matchId));
    let blocks = 0;
    let blockEnd = Number.NEGATIVE_INFINITY;
    for (const assignment of list) {
      if (blocks === 0 || assignment.start - blockEnd > gapMs) blocks++;
      blockEnd = Math.max(blockEnd, assignment.end);
    }
    fragmentation += Math.max(0, blocks - 1);
  }
  return fragmentation;
}

/**
 * Counts `sequence` inversions in start order within each group key, over assignments whose match
 * declares a `sequence`.
 */
export function softOrderInversions(
  matchById: ReadonlyMap<string, ScheduleMatch>,
  assignments: readonly Assignment[],
): number {
  const byGroup = new Map<string, { start: number; sequence: number }[]>();
  for (const assignment of assignments) {
    const match = matchById.get(assignment.matchId);
    if (!match || match.sequence == null) continue;
    const list = byGroup.get(match.groupKey) ?? [];
    list.push({ start: assignment.start, sequence: match.sequence });
    byGroup.set(match.groupKey, list);
  }

  let inversions = 0;
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i]!.sequence > list[j]!.sequence) inversions++;
      }
    }
  }
  return inversions;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function maxOrNull(values: readonly number[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (best == null || value > best) best = value;
  }
  return best;
}

interface ResourceInterval {
  resourceId: string;
  start: number;
  end: number;
}

function occupancyMap(
  intervals: readonly ResourceInterval[],
  clipFrom?: number,
  clipTo?: number,
): Map<string, TimeWindow[]> {
  const map = new Map<string, TimeWindow[]>();
  for (const interval of intervals) {
    const start = clipFrom == null ? interval.start : Math.max(interval.start, clipFrom);
    const end = clipTo == null ? interval.end : Math.min(interval.end, clipTo);
    if (end <= start) continue;
    const list = map.get(interval.resourceId) ?? [];
    list.push({ start, end });
    map.set(interval.resourceId, list);
  }
  return map;
}

/** What a solver hands to `buildSolution` beyond its own decisions. */
export interface SolutionAssembly {
  solverId: string;
  runs: number;
  seed: number;
  deadlockReason: string | null;
  fragmentationGapMinutes: number;
  trace?: readonly SolverTraceEntry[] | undefined;
}

/**
 * The single place a `Solution` is assembled: both metric families, the diagnostics mirror and the
 * objective tuple. Solvers never compute metrics themselves.
 */
export function buildSolution(
  problem: SchedulingProblem,
  assignments: readonly Assignment[],
  unscheduled: readonly string[],
  assembly: SolutionAssembly,
): Solution {
  const fixedIds = new Set(problem.matches.filter((match) => match.fixed).map((match) => match.id));
  const anchors = problem.anchors ?? [];
  const resourceCount = problem.resources.length;

  const allIntervals: ResourceInterval[] = [
    ...assignments.map((assignment) => ({
      resourceId: assignment.resourceId,
      start: assignment.start,
      end: assignment.end,
    })),
    ...anchors
      .filter((anchor) => anchor.resourceId != null)
      .map((anchor) => ({
        resourceId: anchor.resourceId!,
        start: anchor.start,
        end: anchor.end,
      })),
  ];

  const knownFinish = maxOrNull([
    ...assignments.map((assignment) => assignment.end),
    ...anchors.map((anchor) => anchor.end),
  ]);
  const decisionFinish = maxOrNull(
    assignments.filter((a) => !fixedIds.has(a.matchId)).map((assignment) => assignment.end),
  );

  const knownOverrunMinutes =
    knownFinish == null ? 0 : Math.max(0, (knownFinish - problem.planningEnd) / MINUTE_MS);
  const decisionAfterCutoff =
    decisionFinish == null ? 0 : Math.max(0, (decisionFinish - problem.planningEnd) / MINUTE_MS);

  const knownSpanMinutes =
    knownFinish == null ? 0 : Math.max(0, (knownFinish - problem.horizonStart) / MINUTE_MS);
  const knownActiveSpanUtilization =
    knownSpanMinutes > 0 && resourceCount > 0
      ? mergedOccupancyMinutes(occupancyMap(allIntervals, problem.horizonStart)) /
        (knownSpanMinutes * resourceCount)
      : 0;

  const windowMinutes = Math.max(0, (problem.planningEnd - problem.horizonStart) / MINUTE_MS);
  const windowUtilization =
    windowMinutes > 0 && resourceCount > 0
      ? mergedOccupancyMinutes(occupancyMap(allIntervals, problem.horizonStart)) /
        (windowMinutes * resourceCount)
      : 0;

  const decisionSpanMinutes =
    decisionFinish == null ? 0 : Math.max(0, (decisionFinish - problem.horizonStart) / MINUTE_MS);
  const decisionCapacity = decisionSpanMinutes * resourceCount;

  let decisionResourceIdle = 0;
  if (decisionCapacity > 0) {
    const solverIntervals = assignments
      .filter((a) => !fixedIds.has(a.matchId))
      .map((a) => ({ resourceId: a.resourceId, start: a.start, end: a.end }));
    const decidedIntervals: ResourceInterval[] = [
      ...assignments
        .filter((a) => fixedIds.has(a.matchId))
        .map((a) => ({ resourceId: a.resourceId, start: a.start, end: a.end })),
      ...anchors
        .filter((anchor) => anchor.resourceId != null)
        .map((anchor) => ({
          resourceId: anchor.resourceId!,
          start: anchor.start,
          end: anchor.end,
        })),
    ];
    const solverOccupancy = mergedOccupancyMinutes(
      occupancyMap(solverIntervals, problem.horizonStart, decisionFinish!),
    );
    const decidedOccupancy = mergedOccupancyMinutes(
      occupancyMap(decidedIntervals, problem.horizonStart, decisionFinish!),
    );
    decisionResourceIdle = Math.max(0, decisionCapacity - solverOccupancy - decidedOccupancy);
  }

  const decisionActiveSpanUtilization =
    decisionCapacity > 0 ? Math.min(1, Math.max(0, 1 - decisionResourceIdle / decisionCapacity)) : 0;

  const solution: Solution = {
    assignments,
    unscheduled,
    knownFinish,
    knownOverrunMinutes,
    knownOverrun: knownOverrunMinutes > 0,
    knownActiveSpanUtilization,
    windowUtilization,
    decisionFinish,
    decisionAfterCutoff,
    decisionResourceIdle,
    decisionActiveSpanUtilization,
    diagnostics: {
      solverId: assembly.solverId,
      runs: assembly.runs,
      seed: assembly.seed,
      makespanMinutes: 0,
      resourceIdleMinutes: 0,
      matchesAfterCutoff: 0,
      minimumObservedRestMinutes: null,
      maximumParticipantExcessWaitMinutes: 0,
      averageParticipantExcessWaitMinutes: 0,
      remainingWindowUtilization: null,
      fragmentation: 0,
      softOrderDeviation: 0,
      winningScore: [],
      deadlockReason: assembly.deadlockReason,
    },
  };

  const matchById = new Map(problem.matches.map((match) => [match.id, match]));
  const solverAssignments = assignments.filter((a) => !fixedIds.has(a.matchId));
  const wait = participantWaitMetrics(matchById, solverAssignments);
  const metrics = metricsOf(problem, solution, assembly.fragmentationGapMinutes);

  const remaining =
    decisionFinish == null
      ? null
      : (() => {
          const remainingMinutes = (problem.planningEnd - decisionFinish) / MINUTE_MS;
          if (remainingMinutes <= 0 || resourceCount === 0) return null;
          const occupancy = mergedOccupancyMinutes(
            occupancyMap(allIntervals, decisionFinish, problem.planningEnd),
          );
          return occupancy / (remainingMinutes * resourceCount);
        })();

  const diagnostics: SolverDiagnostics = {
    solverId: assembly.solverId,
    runs: assembly.runs,
    seed: assembly.seed,
    makespanMinutes: metrics.makespan,
    resourceIdleMinutes: solution.decisionResourceIdle,
    matchesAfterCutoff: assignments.filter((a) => a.end > problem.planningEnd).length,
    minimumObservedRestMinutes: wait.minimumRest,
    maximumParticipantExcessWaitMinutes: wait.maximumExcessWait,
    averageParticipantExcessWaitMinutes: wait.averageExcessWait,
    remainingWindowUtilization: remaining,
    fragmentation: metrics.fragmentation,
    softOrderDeviation: metrics.softOrderDeviation,
    winningScore: metricsTuple(metrics, objectiveOrderOf(problem)),
    deadlockReason: assembly.deadlockReason,
    ...(assembly.trace ? { trace: assembly.trace } : {}),
  };

  return { ...solution, diagnostics };
}
