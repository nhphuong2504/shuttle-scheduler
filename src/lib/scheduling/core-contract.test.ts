/**
 * Contract tests for the parts the fixture matrix does not reach directly: metric formulas,
 * the reporting/optimization split, preflight issues, structured violation contexts, the solver
 * registry, and the GRASP event loop's specific boundary rules.
 */

import { describe, expect, it } from "vitest";

import { validateSolution } from "./constraints";
import {
  compareIds,
  compareResources,
  type Assignment,
  type ScheduleMatch,
  type SchedulingProblem,
  type Violation,
} from "./domain";
import { FIXTURES, fixtureById } from "./fixtures.test-helpers";
import {
  assertValidSolution,
  at,
  match,
  resource,
  sortedAssignmentKeys,
  T0,
} from "./invariant-harness.test-helpers";
import {
  buildSolution,
  compareMetrics,
  groupFragmentation,
  metricsOf,
  softOrderInversions,
  type SolutionMetrics,
  type SolutionAssembly,
} from "./metrics";
import { ProblemValidationError, validateProblem, type ProblemIssueKind } from "./preflight";
import { getSolver, listSolvers, registerSolver, solve } from "./solvers";
import { assertValidProblem } from "./preflight";

const ASSEMBLY: SolutionAssembly = {
  solverId: "test",
  runs: 1,
  seed: 0,
  deadlockReason: null,
  fragmentationGapMinutes: 30,
};

function solutionWith(
  problem: SchedulingProblem,
  assignments: Assignment[],
  unscheduled: string[] = [],
) {
  return buildSolution(problem, assignments, unscheduled, ASSEMBLY);
}

function assign(matchId: string, startMinutes: number, duration = 30, resourceId = "r1"): Assignment {
  const start = at(startMinutes);
  return {
    matchId,
    resourceId,
    resourceOrder: 1,
    start,
    end: start + duration * 60_000,
    groupKey: "g",
  };
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

describe("metric formulas", () => {
  it("sums excess wait over consecutive assignments, not max or average", () => {
    const problem: SchedulingProblem = {
      matches: [
        match({ id: "m1", participants: ["p"], duration: 30, restAfter: 10 }),
        match({ id: "m2", participants: ["p"], duration: 30 }),
        match({ id: "m3", participants: ["p"], duration: 30 }),
      ],
      resources: [resource("r1", 1)],
      horizonStart: T0,
      planningEnd: at(600),
      hardEnd: null,
      floor: T0,
    };
    // m1 [0,30], m2 [60,90]: gap 30, required 10 => excess 20.
    // m2 [60,90], m3 [120,150]: gap 30, required 0 => excess 30. Total 50, not the max (30).
    const solution = solutionWith(problem, [assign("m1", 0), assign("m2", 60), assign("m3", 120)]);
    expect(metricsOf(problem, solution).excessWait).toBe(50);
  });

  it("counts fragments as blocks beyond the first, per completion key", () => {
    const problem: SchedulingProblem = {
      matches: [
        match({ id: "a", participants: ["a"], groupKey: "g", completionKey: "pool" }),
        match({ id: "b", participants: ["b"], groupKey: "g", completionKey: "pool" }),
        match({ id: "c", participants: ["c"], groupKey: "g", completionKey: "pool" }),
      ],
      resources: [resource("r1", 1)],
      horizonStart: T0,
      planningEnd: at(600),
      hardEnd: null,
      floor: T0,
    };
    const byId = new Map(problem.matches.map((m) => [m.id, m]));
    // a and b touch; c is 270 minutes after b's end, well past the 30-minute gap.
    expect(groupFragmentation(byId, [assign("a", 0), assign("b", 30), assign("c", 330)], 30)).toBe(1);
    expect(groupFragmentation(byId, [assign("a", 0), assign("b", 30), assign("c", 60)], 30)).toBe(0);
  });

  it("counts sequence inversions in start order within a group", () => {
    const problem: SchedulingProblem = {
      matches: [
        match({ id: "first", participants: ["a"], groupKey: "g", sequence: 1 }),
        match({ id: "second", participants: ["b"], groupKey: "g", sequence: 2 }),
      ],
      resources: [resource("r1", 1)],
      horizonStart: T0,
      planningEnd: at(600),
      hardEnd: null,
      floor: T0,
    };
    const byId = new Map(problem.matches.map((m) => [m.id, m]));
    expect(softOrderInversions(byId, [assign("first", 0), assign("second", 30)])).toBe(0);
    expect(softOrderInversions(byId, [assign("second", 0), assign("first", 30)])).toBe(1);
  });

  it("is pure: metricsOf does not read diagnostics and is stable across calls", () => {
    const fixture = fixtureById("F1");
    const solution = solve(fixture.problem, "greedy");
    const first = metricsOf(fixture.problem, solution);
    const corrupted = {
      ...solution,
      diagnostics: { ...solution.diagnostics, winningScore: [999], makespanMinutes: -1 },
    };
    expect(metricsOf(fixture.problem, corrupted)).toEqual(first);
  });

  it("compares lexicographically, so a higher-priority criterion is never traded away", () => {
    const base: SolutionMetrics = {
      unscheduled: 0,
      afterCutoff: 0,
      makespan: 100,
      resourceIdle: 0,
      excessWait: 0,
      fragmentation: 0,
      softOrderDeviation: 0,
    };
    const slightlyLate: SolutionMetrics = { ...base, afterCutoff: 1, makespan: 0 };
    expect(compareMetrics(slightlyLate, base)).toBeGreaterThan(0);
    const better: SolutionMetrics = { ...base, makespan: 99 };
    expect(compareMetrics(better, base)).toBeLessThan(0);
    expect(compareMetrics(base, base)).toBe(0);
  });
});

describe("reporting vs optimization families", () => {
  it("a late anchor changes reporting metrics and leaves optimization metrics untouched", () => {
    const base = fixtureById("F10").problem;
    const withoutAnchor: SchedulingProblem = { ...base, anchors: [] };
    const withAnchor = base;

    const withoutSolution = solve(withoutAnchor, "greedy");
    const withSolution = solve(withAnchor, "greedy");

    // The anchor sits after the solved match and shares nothing that changes its placement.
    expect(withoutSolution.decisionFinish).toBe(withSolution.decisionFinish);
    expect(withoutSolution.decisionAfterCutoff).toBe(withSolution.decisionAfterCutoff);
    expect(withoutSolution.decisionResourceIdle).toBe(withSolution.decisionResourceIdle);
    expect(withoutSolution.decisionActiveSpanUtilization).toBe(
      withSolution.decisionActiveSpanUtilization,
    );

    // Reporting is where the anchor shows up.
    expect(withSolution.knownFinish).toBe(at(180));
    expect(withoutSolution.knownFinish).toBe(at(30));
    expect(withSolution.knownOverrunMinutes).toBe(120);
    expect(withoutSolution.knownOverrunMinutes).toBe(0);
  });

  it("a resource-holding anchor consumes decided occupancy inside the decision span", () => {
    const problem: SchedulingProblem = {
      matches: [match({ id: "m", participants: ["p"], duration: 30 })],
      resources: [resource("r1", 1)],
      horizonStart: T0,
      planningEnd: at(600),
      hardEnd: null,
      floor: T0,
      anchors: [
        { id: "a", participantIds: ["x"], start: at(30), end: at(60), resourceId: "r1" },
      ],
    };
    const solution = solutionWith(problem, [assign("m", 0)]);
    // Decision span [0,30] on 1 resource = 30 capacity; the anchor is clipped to the span, so it
    // consumes nothing and the idle count is 0.
    expect(solution.decisionResourceIdle).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------------------------

describe("validateProblem", () => {
  const base = (): SchedulingProblem => ({
    matches: [],
    resources: [resource("r1", 1)],
    horizonStart: T0,
    planningEnd: at(540),
    hardEnd: null,
    floor: T0,
  });

  function kinds(problem: SchedulingProblem): ProblemIssueKind[] {
    return validateProblem(problem).map((issue) => issue.kind);
  }

  it("accepts every fixture", () => {
    for (const fixture of FIXTURES) {
      expect(validateProblem(fixture.problem), fixture.id).toEqual([]);
    }
  });

  it("reports each fixed-match input error separately from an unscheduled outcome", () => {
    const problem: SchedulingProblem = {
      ...base(),
      matches: [
        match({ id: "no-times", participants: ["p"], duration: 30, fixed: true }),
        match({ id: "no-resource", participants: ["p"], duration: 30, fixed: true, start: T0, end: at(30) }),
        match({
          id: "unknown-resource",
          participants: ["p"],
          duration: 30,
          fixed: true,
          start: T0,
          end: at(30),
          resourceId: "nope",
        }),
        match({
          id: "bad-range",
          participants: ["p"],
          duration: 30,
          fixed: true,
          start: at(30),
          end: at(30),
          resourceId: "r1",
        }),
      ],
    };
    const found = kinds(problem);
    expect(found).toContain("fixed-missing-start");
    expect(found).toContain("fixed-missing-end");
    expect(found).toContain("fixed-missing-resource");
    expect(found).toContain("fixed-unknown-resource");
    expect(found).toContain("fixed-invalid-range");
  });

  it("rejects a resource conflict between two fixed matches but tolerates a recorded rest overlap", () => {
    const conflicting: SchedulingProblem = {
      ...base(),
      matches: [
        match({
          id: "f1",
          participants: ["shared"],
          duration: 30,
          fixed: true,
          start: T0,
          end: at(30),
          resourceId: "r1",
          restAfter: 60,
        }),
        match({
          id: "f2",
          participants: ["shared"],
          duration: 30,
          fixed: true,
          start: at(60),
          end: at(90),
          resourceId: "r2",
        }),
      ],
      resources: [resource("r1", 1), resource("r2", 2)],
    };
    // f2 starts before f1's required rest elapsed, which is *history*, not a choice: two decided
    // occupancies are both facts, so this is deliberately not a problem-construction error.
    expect(kinds(conflicting)).not.toContain("fixed-participant-conflict");

    // Two fixed matches on one court at once is a physical impossibility, so it stays an error.
    const doubleBooked: SchedulingProblem = {
      ...base(),
      matches: [
        match({
          id: "f1",
          participants: ["a"],
          duration: 30,
          fixed: true,
          start: T0,
          end: at(30),
          resourceId: "r1",
        }),
        match({
          id: "f2",
          participants: ["b"],
          duration: 30,
          fixed: true,
          start: at(10),
          end: at(40),
          resourceId: "r1",
        }),
      ],
      resources: [resource("r1", 1)],
    };
    expect(kinds(doubleBooked)).toContain("fixed-resource-conflict");
  });

  it("rejects anchor conflicts, self dependencies and cycles of unknown ids", () => {
    const problem: SchedulingProblem = {
      ...base(),
      matches: [
        match({ id: "self", participants: ["p"], duration: 30, deps: ["self"] }),
        match({ id: "dangling", participants: ["p"], duration: 30, deps: ["ghost"] }),
      ],
      anchors: [
        { id: "a1", participantIds: ["p2"], start: T0, end: at(30), resourceId: "r1" },
        { id: "a2", participantIds: ["p2"], start: at(10), end: at(40), resourceId: "r1" },
      ],
    };
    const found = kinds(problem);
    expect(found).toContain("self-dependency");
    expect(found).toContain("unknown-dependency");
    expect(found).toContain("anchor-conflict");
  });

  it("rejects hardEnd before planningEnd and duplicate ids", () => {
    const problem: SchedulingProblem = {
      ...base(),
      hardEnd: at(500),
      resources: [resource("r1", 1), resource("r1", 1)],
      matches: [
        match({ id: "dup", participants: ["p"], duration: 30 }),
        match({ id: "dup", participants: ["p"], duration: 30 }),
      ],
    };
    const found = kinds(problem);
    expect(found).toContain("hard-end-before-planning-end");
    expect(found).toContain("duplicate-match-id");
    expect(found).toContain("duplicate-resource-id");
  });

  it("orders issues deterministically", () => {
    const problem: SchedulingProblem = {
      ...base(),
      matches: [match({ id: "b", participants: ["p"], duration: 30, deps: ["b", "zz"] })],
      resources: [resource("r1", 1), resource("r1", 1)],
    };
    const first = validateProblem(problem);
    const second = validateProblem(problem);
    expect(first).toEqual(second);
    expect(compareIds(first[0]!.kind, first[first.length - 1]!.kind)).toBeLessThanOrEqual(0);
  });

  it("throws ProblemValidationError carrying every issue", () => {
    const problem = base();
    problem.matches = [match({ id: "x", participants: ["p"], duration: 30, fixed: true })];
    expect(() => assertValidProblem(problem)).toThrow(ProblemValidationError);
    try {
      assertValidProblem(problem);
    } catch (error) {
      expect((error as ProblemValidationError).issues.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// validateSolution violation contexts
// ---------------------------------------------------------------------------------------------

describe("validateSolution contexts", () => {
  const problem: SchedulingProblem = {
    matches: [
      match({ id: "m1", participants: ["p"], duration: 30, groupKey: "g" }),
      match({ id: "m2", participants: ["p"], duration: 30, groupKey: "g", deps: ["m1"] }),
    ],
    resources: [resource("r1", 1)],
    horizonStart: T0,
    planningEnd: at(540),
    hardEnd: null,
    floor: T0,
  };

  function kindsOf(violations: Violation[]): string[] {
    return violations.map((violation) => violation.kind).sort(compareIds);
  }

  it("keeps the two unknown-match sources as distinct kinds", () => {
    const solution = solutionWith(
      problem,
      [assign("ghost-assignment", 0)],
      ["ghost-unscheduled"],
    );
    const found = kindsOf(validateSolution(problem, solution));
    expect(found).toContain("unknown-assignment-match");
    expect(found).toContain("unknown-unscheduled-match");
  });

  it("reports every problem match that is not accounted for exactly once", () => {
    const solution = solutionWith(problem, [assign("m1", 0)]);
    expect(kindsOf(validateSolution(problem, solution))).toContain("appearance-count");
  });

  it("distinguishes a participant overlap from a rest-gap shortfall", () => {
    const overlap = solutionWith(problem, [assign("m1", 0), assign("m2", 10)]);
    expect(kindsOf(validateSolution(problem, overlap))).toContain("participant-overlap");

    const withRest: SchedulingProblem = {
      ...problem,
      matches: [
        match({ id: "m1", participants: ["p"], duration: 30, groupKey: "g", restAfter: 60 }),
        match({ id: "m2", participants: ["p"], duration: 30, groupKey: "g" }),
      ],
    };
    const tooClose = solutionWith(withRest, [assign("m1", 0), assign("m2", 40)]);
    const violations = validateSolution(withRest, tooClose);
    const restGap = violations.find((violation) => violation.kind === "rest-gap");
    expect(restGap).toBeDefined();
    expect(restGap!.requiredMinutes).toBe(60);
    expect(restGap!.restMinutes).toBe(10);
  });

  it("flags a dependency that had not finished", () => {
    const solution = solutionWith(problem, [assign("m1", 0), assign("m2", 20)]);
    expect(kindsOf(validateSolution(problem, solution))).toContain("dependency");
  });

  it("flags an assignment outside the resource's availability", () => {
    const windowed: SchedulingProblem = {
      ...problem,
      matches: [match({ id: "m1", participants: ["p"], duration: 30, groupKey: "g", resourceCandidates: ["r1"] })],
      resources: [resource("r1", 1, { availability: [{ start: at(60), end: at(120) }] })],
    };
    const solution = solutionWith(windowed, [assign("m1", 0)]);
    expect(kindsOf(validateSolution(windowed, solution))).toContain("outside-availability");
  });
});

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

describe("solver registry", () => {
  it("lists the built-in strategies in canonical order", () => {
    expect(listSolvers().map((solver) => solver.id)).toEqual(["grasp", "greedy"]);
  });

  it("rejects a duplicate id", () => {
    expect(() => registerSolver({ id: "greedy", name: "dup", solve: () => ({}) as never })).toThrow(
      /already registered/,
    );
  });

  it("names the known ids when an id is unknown", () => {
    expect(() => getSolver("nope")).toThrow(/Known solvers: grasp, greedy/);
  });
});

// ---------------------------------------------------------------------------------------------
// GRASP event loop
// ---------------------------------------------------------------------------------------------

describe("GRASP event loop", () => {
  it("unlocks on the candidate's own restBefore, not the decided occupancy's restAfter", () => {
    const fixture = fixtureById("F6");
    const solution = solve(fixture.problem, "grasp", { runs: 4, seed: 3 });
    assertValidSolution(fixture.problem, solution);
    const next = solution.assignments.find((assignment) => assignment.matchId === "next");
    expect(next).toBeDefined();
    // prev ends at +30 with restAfter 10; next needs restBefore 30, so the unlock is +60.
    expect(next!.start).toBe(at(60));
  });

  it("keeps eventTime === hardEnd so a zero-duration match can start exactly at the wall", () => {
    const fixture = fixtureById("F8");
    const solution = solve(fixture.problem, "grasp", { runs: 4, seed: 5 });
    assertValidSolution(fixture.problem, solution);
    expect(solution.unscheduled).toEqual([]);
    expect(solution.assignments.find((a) => a.matchId === "zero")?.start).toBe(at(30));
  });

  it("sweeps the same timestamp to quiescence for a zero-duration dependency chain", () => {
    // b depends on a, c depends on b, and both a and b take zero minutes, so all three can share
    // one timestamp only if the timestamp is swept again after each assignment.
    const problem: SchedulingProblem = {
      matches: [
        match({ id: "a", participants: ["pa"], duration: 0 }),
        match({ id: "b", participants: ["pb"], duration: 0, deps: ["a"] }),
        match({ id: "c", participants: ["pc"], duration: 0, deps: ["b"] }),
      ],
      resources: [resource("r1", 1)],
      horizonStart: T0,
      planningEnd: at(540),
      hardEnd: null,
      floor: T0,
    };
    const solution = solve(problem, "grasp", { runs: 2, seed: 1 });
    assertValidSolution(problem, solution);
    expect(solution.unscheduled).toEqual([]);
    for (const id of ["a", "b", "c"]) {
      expect(solution.assignments.find((assignment) => assignment.matchId === id)?.start).toBe(T0);
    }
  });

  it("is independent of input order", () => {
    const fixture = fixtureById("F3");
    const shuffled: SchedulingProblem = {
      ...fixture.problem,
      matches: [...fixture.problem.matches].reverse(),
    };
    const first = solve(fixture.problem, "grasp", { runs: 6, seed: 9 });
    const second = solve(shuffled, "grasp", { runs: 6, seed: 9 });
    expect(sortedAssignmentKeys(second)).toEqual(sortedAssignmentKeys(first));
  });

  it("routes matches through the resource comparator when several free at once", () => {
    const problem: SchedulingProblem = {
      matches: [
        match({ id: "m", participants: ["p"], duration: 30, resourceCandidates: ["b", "a"] }),
      ],
      resources: [resource("b", 1), resource("a", 2)],
      horizonStart: T0,
      planningEnd: at(540),
      hardEnd: null,
      floor: T0,
    };
    expect(compareResources(problem.resources[0]!, problem.resources[1]!)).toBeLessThan(0);
    const solution = solve(problem, "grasp", { runs: 2, seed: 1 });
    expect(solution.assignments[0]!.resourceId).toBe("b");
  });
});
