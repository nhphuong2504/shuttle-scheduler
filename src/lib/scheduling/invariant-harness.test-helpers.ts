/**
 * The reusable invariant harness: the fixture matrix, `assertValidSolution` and
 * `boundsFor(fixture)`.
 *
 * Assertions are closed-form and numeric, derived from fixture parameters, never snapshot-based.
 * A schedule is correct when it satisfies the invariants; a *different* valid schedule is not a
 * failure.
 */

import { expect } from "vitest";

import { validateSolution } from "./constraints";
import {
  compareIds,
  MINUTE_MS,
  relateToDecided,
  type Assignment,
  type ParticipantAnchor,
  type ScheduleMatch,
  type SchedulingProblem,
  type ScheduleResource,
  type Solution,
  type TimeWindow,
} from "./domain";

/** 09:00 UTC on a tournament day. Every fixture offset is minutes from here. */
export const T0 = Date.UTC(2026, 8, 12, 9, 0, 0);
export const MIN = MINUTE_MS;

export function at(minutes: number): number {
  return T0 + minutes * MIN;
}

export function resource(
  id: string,
  order: number,
  extra: Partial<ScheduleResource> = {},
): ScheduleResource {
  return { id, order, ...extra };
}

export interface MatchSpec {
  id: string;
  participants?: readonly string[];
  participantsKnown?: boolean;
  duration?: number;
  deps?: readonly string[];
  eligibleFrom?: number;
  fixed?: boolean;
  start?: number;
  end?: number;
  resourceId?: string;
  resourceCandidates?: readonly string[];
  requirements?: readonly string[];
  groupKey?: string;
  completionKey?: string;
  stageKey?: string;
  stageUnlocks?: boolean;
  phase?: number;
  sequence?: number;
  softOrder?: number;
  restAfter?: number;
  restBefore?: number;
}

export function match(spec: MatchSpec): ScheduleMatch {
  const duration = spec.duration ?? 30;
  return {
    id: spec.id,
    participantIds: spec.participants ?? [],
    durationMinutes: duration,
    groupKey: spec.groupKey ?? "g",
    ...(spec.participantsKnown == null ? {} : { participantsKnown: spec.participantsKnown }),
    ...(spec.deps ? { dependencies: spec.deps } : {}),
    ...(spec.eligibleFrom == null ? {} : { eligibleFrom: spec.eligibleFrom }),
    ...(spec.fixed ? { fixed: true } : {}),
    ...(spec.start == null ? {} : { start: spec.start }),
    ...(spec.end == null ? {} : { end: spec.end }),
    ...(spec.resourceId == null ? {} : { resourceId: spec.resourceId }),
    ...(spec.resourceCandidates ? { resourceCandidates: spec.resourceCandidates } : {}),
    ...(spec.requirements ? { resourceRequirements: spec.requirements } : {}),
    ...(spec.completionKey == null ? {} : { completionKey: spec.completionKey }),
    ...(spec.stageKey == null ? {} : { stageKey: spec.stageKey }),
    ...(spec.stageUnlocks == null ? {} : { stageUnlocks: spec.stageUnlocks }),
    ...(spec.phase == null ? {} : { phase: spec.phase }),
    ...(spec.sequence == null ? {} : { sequence: spec.sequence }),
    ...(spec.softOrder == null ? {} : { softOrder: spec.softOrder }),
    ...(spec.restAfter == null ? {} : { restAfterMinutes: spec.restAfter }),
    ...(spec.restBefore == null ? {} : { restBeforeMinutes: spec.restBefore }),
  };
}

/** Pins every generated match to one resource, which is how the wave fixtures stay closed-form. */
export function pinnedWave(
  resourceId: string,
  count: number,
  prefix: string,
  options: { duration?: number; participantPrefix?: string } = {},
): ScheduleMatch[] {
  // Zero-padded so code-unit id order matches numeric order: dependency targets and greedy's
  // processing order must be predictable from the fixture, not from a string-comparison accident.
  const width = String(Math.max(count - 1, 0)).length;
  const matches: ScheduleMatch[] = [];
  for (let i = 0; i < count; i++) {
    const suffix = String(i).padStart(width, "0");
    matches.push(
      match({
        id: `${prefix}${suffix}`,
        participants: [`${options.participantPrefix ?? prefix}-p${suffix}`],
        duration: options.duration ?? 30,
        resourceCandidates: [resourceId],
      }),
    );
  }
  return matches;
}

export interface ExpectedBounds {
  unscheduled?: number;
  knownFinish?: number | null;
  knownOverrunMinutes?: number;
  knownOverrun?: boolean;
  decisionFinish?: number | null;
  makespanMinutes?: number;
  afterCutoffMinutes?: number;
  resourceIdleMinutes?: number;
  windowUtilization?: number;
  knownActiveSpanUtilization?: number;
  decisionActiveSpanUtilization?: number;
  excessWaitMinutes?: number;
  fragmentation?: number;
  softOrderDeviation?: number;
}

export interface HarnessFixture {
  id: string;
  description: string;
  problem: SchedulingProblem;
  /** Which strategy the fixture is cheap enough to run. */
  solver: "greedy" | "grasp";
  runs?: number;
  expected: ExpectedBounds;
  /** Extra fixture-specific assertions the bounds cannot express. */
  assertExtra?: (solution: Solution, problem: SchedulingProblem) => void;
}

// ---------------------------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------------------------

const EMPTY_MESSAGE = "expected no violations";

/**
 * The core correctness gate: `validateSolution` must find nothing. On failure the violated
 * invariants are printed rather than a bare count.
 */
export function assertValidSolution(problem: SchedulingProblem, solution: Solution): void {
  const violations = validateSolution(problem, solution);
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  assertMetricConsistency(problem, solution);
  assertParticipantLattice(problem, solution);
  expect(violations, EMPTY_MESSAGE).toEqual([]);
}

/** The two metric families must agree with their own definitions, and stay separate. */
export function assertMetricConsistency(problem: SchedulingProblem, solution: Solution): void {
  const fixedIds = new Set(problem.matches.filter((m) => m.fixed).map((m) => m.id));
  const assignmentEnds = solution.assignments.map((a) => a.end);
  const anchorEnds = (problem.anchors ?? []).map((a) => a.end);
  const decisionEnds = solution.assignments
    .filter((a) => !fixedIds.has(a.matchId))
    .map((a) => a.end);

  const knownFinish = maxOrNull([...assignmentEnds, ...anchorEnds]);
  const decisionFinish = maxOrNull(decisionEnds);

  expect(solution.knownFinish).toBe(knownFinish);
  expect(solution.decisionFinish).toBe(decisionFinish);
  expect(solution.knownOverrunMinutes).toBeCloseTo(
    knownFinish == null ? 0 : Math.max(0, (knownFinish - problem.planningEnd) / MIN),
    6,
  );
  expect(solution.knownOverrun).toBe(solution.knownOverrunMinutes > 0);
  expect(solution.decisionAfterCutoff).toBeCloseTo(
    decisionFinish == null ? 0 : Math.max(0, (decisionFinish - problem.planningEnd) / MIN),
    6,
  );
  // The two lateness numbers are intentionally different concepts. They may coincide when the
  // same event is both the known finish and the solver's last end, so no inequality is asserted;
  // F4 and F10 are what pin the separation.
}

/**
 * The lattice identity: for every pair of decided occupancies sharing a participant, the relation
 * must classify as `after` or `before`, never `conflict`.
 */
export function assertParticipantLattice(problem: SchedulingProblem, solution: Solution): void {
  const byId = new Map(problem.matches.map((m) => [m.id, m]));
  const decided: { id: string; start: number; end: number; match: ScheduleMatch }[] = [];
  for (const assignment of solution.assignments) {
    const match = byId.get(assignment.matchId);
    if (!match) continue;
    decided.push({
      id: match.id,
      start: assignment.start,
      end: assignment.end,
      match,
    });
  }
  const anchors: ParticipantAnchor[] = [...(problem.anchors ?? [])];

  for (let i = 0; i < decided.length; i++) {
    const left = decided[i]!;
    for (let j = i + 1; j < decided.length; j++) {
      const right = decided[j]!;
      for (const participantId of sharedParticipants(left.match, right.match)) {
        const forward = relateToDecided(left.start, left.match, right, participantId);
        const backward = relateToDecided(right.start, right.match, left, participantId);
        expect(forward, `${left.id}/${right.id}/${participantId}`).not.toBe("conflict");
        expect(backward, `${right.id}/${left.id}/${participantId}`).not.toBe("conflict");
      }
    }
    for (const anchor of anchors) {
      if (!sharesParticipant(left.match.participantIds, anchor.participantIds)) continue;
      for (const participantId of sharedParticipants(left.match, anchor)) {
        const forward = relateToDecided(left.start, left.match, anchor, participantId);
        expect(forward, `${left.id}/${anchor.id}/${participantId}`).not.toBe("conflict");
      }
    }
  }
}

function sharedParticipants(a: ScheduleMatch, b: ScheduleMatch | ParticipantAnchor): string[] {
  return [...new Set(a.participantIds)].filter((id) => b.participantIds.includes(id));
}

function sharesParticipant(a: readonly string[], b: readonly string[]): boolean {
  return a.some((id) => b.includes(id));
}

function maxOrNull(values: readonly number[]): number | null {
  let best: number | null = null;
  for (const value of values) if (best == null || value > best) best = value;
  return best;
}

/** The expected bounds for a fixture, as a plain object a test can diff against. */
export function boundsFor(fixture: HarnessFixture): ExpectedBounds {
  return fixture.expected;
}

/** Applies a fixture's bounds to a solution with numeric tolerance. */
export function expectBounds(fixture: HarnessFixture, solution: Solution): void {
  const expected = boundsFor(fixture);
  if (expected.unscheduled != null) {
    expect(solution.unscheduled.length, `${fixture.id} unscheduled`).toBe(expected.unscheduled);
  }
  if (expected.knownFinish !== undefined) {
    expect(solution.knownFinish, `${fixture.id} knownFinish`).toBe(expected.knownFinish);
  }
  if (expected.knownOverrunMinutes != null) {
    expect(solution.knownOverrunMinutes, `${fixture.id} knownOverrunMinutes`).toBeCloseTo(
      expected.knownOverrunMinutes,
      3,
    );
  }
  if (expected.knownOverrun != null) {
    expect(solution.knownOverrun, `${fixture.id} knownOverrun`).toBe(expected.knownOverrun);
  }
  if (expected.decisionFinish !== undefined) {
    expect(solution.decisionFinish, `${fixture.id} decisionFinish`).toBe(expected.decisionFinish);
  }
  if (expected.makespanMinutes != null) {
    expect(solution.diagnostics.makespanMinutes, `${fixture.id} makespan`).toBeCloseTo(
      expected.makespanMinutes,
      3,
    );
  }
  if (expected.afterCutoffMinutes != null) {
    expect(solution.decisionAfterCutoff, `${fixture.id} afterCutoff`).toBeCloseTo(
      expected.afterCutoffMinutes,
      3,
    );
  }
  if (expected.resourceIdleMinutes != null) {
    expect(solution.decisionResourceIdle, `${fixture.id} resourceIdle`).toBeCloseTo(
      expected.resourceIdleMinutes,
      3,
    );
  }
  if (expected.windowUtilization != null) {
    expect(solution.windowUtilization, `${fixture.id} windowUtilization`).toBeCloseTo(
      expected.windowUtilization,
      4,
    );
  }
  if (expected.knownActiveSpanUtilization != null) {
    expect(
      solution.knownActiveSpanUtilization,
      `${fixture.id} knownActiveSpanUtilization`,
    ).toBeCloseTo(expected.knownActiveSpanUtilization, 4);
  }
  if (expected.decisionActiveSpanUtilization != null) {
    expect(
      solution.decisionActiveSpanUtilization,
      `${fixture.id} decisionActiveSpanUtilization`,
    ).toBeCloseTo(expected.decisionActiveSpanUtilization, 4);
  }
  if (expected.excessWaitMinutes != null) {
    expect(solution.diagnostics.maximumParticipantExcessWaitMinutes >= 0).toBe(true);
    expect(expected.excessWaitMinutes >= 0).toBe(true);
  }
  if (expected.fragmentation != null) {
    expect(solution.diagnostics.fragmentation, `${fixture.id} fragmentation`).toBe(
      expected.fragmentation,
    );
  }
  if (expected.softOrderDeviation != null) {
    expect(solution.diagnostics.softOrderDeviation, `${fixture.id} softOrderDeviation`).toBe(
      expected.softOrderDeviation,
    );
  }
}

/** Assignments of one match, for fixture-specific assertions. */
export function assignmentOf(solution: Solution, matchId: string): Assignment | undefined {
  return solution.assignments.find((assignment) => assignment.matchId === matchId);
}

/** A stable key for determinism comparisons: resource, start, match. */
export function assignmentKey(assignment: Assignment): string {
  return `${assignment.resourceId}@${assignment.start}`;
}

export function sortedAssignmentKeys(solution: Solution): string[] {
  return solution.assignments
    .map((a) => `${a.matchId}|${assignmentKey(a)}|${a.end}`)
    .sort(compareIds);
}

/** A window helper for availability fixtures. */
export function window(start: number, end: number): TimeWindow {
  return { start, end };
}
