/**
 * The generic core's own tests: invariant-clean fixtures with closed-form bounds, the
 * bidirectional interval relation, canonical ordering, and solver interchangeability.
 *
 * These tests never assert a snapshot. Two different valid schedules both pass.
 */

import { describe, expect, it } from "vitest";

import { solve } from "./solvers";
import { greedySolver } from "./solvers/greedy";
import { graspSolver } from "./solvers/grasp";
import { hybridSolver } from "./solvers/hybrid";
import {
  compareIds,
  compareResources,
  completionKeyOf,
  forbiddenStartInterval,
  relateToDecided,
  requiredRestBetween,
  type ScheduleMatch,
} from "./domain";
import { FIXTURES, fixtureById } from "./fixtures.test-helpers";
import {
  assertValidSolution,
  assignmentOf,
  at,
  expectBounds,
  match,
  sortedAssignmentKeys,
  type HarnessFixture,
} from "./invariant-harness.test-helpers";

function runFixture(fixture: HarnessFixture) {
  const solution = solve(
    fixture.problem,
    fixture.solver,
    fixture.runs == null ? {} : { runs: fixture.runs },
  );
  assertValidSolution(fixture.problem, solution);
  expectBounds(fixture, solution);
  return solution;
}

describe("generic core fixtures", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.id}: ${fixture.description}`, () => {
      const solution = runFixture(fixture);
      if (fixture.assertExtra) fixture.assertExtra(solution, fixture.problem);
    });
  }
});

describe("solver interchangeability", () => {
  it("greedy and GRASP both produce invariant-clean schedules for F1", () => {
    const fixture = fixtureById("F1");
    const greedy = solve(fixture.problem, "greedy");
    const grasp = solve(fixture.problem, "grasp", { runs: 8, seed: 7 });
    assertValidSolution(fixture.problem, greedy);
    assertValidSolution(fixture.problem, grasp);
    expect(greedy.unscheduled).toEqual([]);
    expect(grasp.unscheduled).toEqual([]);
    // Both are optimal on a chain: no idle gap can beat the dependency-imposed makespan.
    expect(greedy.diagnostics.makespanMinutes).toBe(280);
    expect(grasp.diagnostics.makespanMinutes).toBe(280);
  });

  it("GRASP is deterministic for the same seed and problem", () => {
    const fixture = fixtureById("F3");
    const first = solve(fixture.problem, "grasp", { runs: 4, seed: 11 });
    const second = solve(fixture.problem, "grasp", { runs: 4, seed: 11 });
    expect(sortedAssignmentKeys(first)).toEqual(sortedAssignmentKeys(second));
  });

  it("exposes interchangeability through the registry", () => {
    expect(greedySolver.id).toBe("greedy");
    expect(graspSolver.id).toBe("grasp");
    expect(hybridSolver.id).toBe("grasp-hybrid");
  });
});

describe("completion key", () => {
  it("falls back to groupKey and never to pool-like emptiness", () => {
    expect(completionKeyOf(match({ id: "m", groupKey: "pool-A" }))).toBe("pool-A");
    expect(completionKeyOf(match({ id: "m", groupKey: "pool-A", completionKey: "final" }))).toBe(
      "final",
    );
  });
});

describe("canonical ordering", () => {
  it("orders integer-like ids by code unit, not numeric value", () => {
    expect(compareIds("10", "9")).toBeLessThan(0);
    expect(compareIds("Z", "a")).toBeLessThan(0);
    expect([...["10", "9", "2"]].sort(compareIds)).toEqual(["10", "2", "9"]);
  });

  it("orders resources by order then id", () => {
    expect(
      compareResources({ id: "b", order: 1 }, { id: "a", order: 1 }),
    ).toBeGreaterThan(0);
    expect(compareResources({ id: "a", order: 1 }, { id: "b", order: 2 })).toBeLessThan(0);
  });
});

describe("requiredRestBetween", () => {
  it("is the max of the previous rest-after and the next rest-before, defaulting missing to 0", () => {
    const previous = match({ id: "p", duration: 30, restAfter: 10 });
    const next = match({ id: "n", duration: 30, restBefore: 30 });
    expect(requiredRestBetween(previous, next, "x")).toBe(30);
    expect(requiredRestBetween(next, previous, "x")).toBe(0);
  });

  it("honours per-participant overrides", () => {
    const previous: ScheduleMatch = {
      ...match({ id: "p", duration: 30, restAfter: 10 }),
      restOverrides: { alice: { afterMinutes: 45 } },
    };
    expect(requiredRestBetween(previous, match({ id: "n", duration: 30 }), "alice")).toBe(45);
    expect(requiredRestBetween(previous, match({ id: "n", duration: 30 }), "bob")).toBe(10);
  });
});

describe("relateToDecided", () => {
  const decided = { start: at(100), end: at(130), restAfterMinutes: 20 };
  const candidate = { durationMinutes: 30 };

  it("classifies the inclusive boundaries as before and after", () => {
    const { lo, hi } = forbiddenStartInterval(candidate, decided, "p");
    expect(relateToDecided(lo, candidate, decided, "p")).toBe("before");
    expect(relateToDecided(hi, candidate, decided, "p")).toBe("after");
  });

  it("classifies the open interval as conflict", () => {
    const { lo, hi } = forbiddenStartInterval(candidate, decided, "p");
    expect(relateToDecided(lo + 1, candidate, decided, "p")).toBe("conflict");
    expect(relateToDecided(hi - 1, candidate, decided, "p")).toBe("conflict");
  });

  it("combines both directions: before uses restBefore of the candidate", () => {
    const withBefore = { ...candidate, restBeforeMinutes: 50 };
    const { lo } = forbiddenStartInterval(withBefore, decided, "p");
    // lo mirrors max(restAfterOf(candidate)=0, restBeforeOf(decided)=0), so it stays at 70.
    expect(lo).toBe(at(100) - 30 * 60_000);
  });

  it("never returns conflict when the forbidden interval is empty", () => {
    const point = { start: at(100), end: at(100) };
    const zero = { durationMinutes: 0 };
    const { lo, hi } = forbiddenStartInterval(zero, point, "p");
    expect(lo).toBeGreaterThanOrEqual(hi);
    expect(relateToDecided(at(100), zero, point, "p")).not.toBe("conflict");
  });
});

describe("bidirectional placement fixtures", () => {
  it("F12 places the candidate before the fixed match", () => {
    const fixture = fixtureById("F12");
    const solution = runFixture(fixture);
    const candidate = assignmentOf(solution, "candidate");
    expect(candidate).toBeDefined();
    expect(candidate!.end).toBeLessThanOrEqual(at(100));
  });

  it("F13 places the candidate before the anchor", () => {
    const fixture = fixtureById("F13");
    const solution = runFixture(fixture);
    const candidate = assignmentOf(solution, "candidate");
    expect(candidate).toBeDefined();
    expect(candidate!.end).toBeLessThanOrEqual(at(100));
  });

  it("F14 lands exactly on the rest boundary", () => {
    const fixture = fixtureById("F14");
    const solution = runFixture(fixture);
    const candidate = assignmentOf(solution, "candidate");
    expect(candidate!.start).toBe(at(70));
    expect(candidate!.end).toBe(at(100));
  });

  it("F15 rejects the forbidden interval instead of emitting it", () => {
    const fixture = fixtureById("F15");
    const solution = runFixture(fixture);
    expect(solution.unscheduled).toContain("candidate");
  });
});
