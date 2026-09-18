/**
 * The hybrid solver's defining property, and the tests that pin why it holds.
 *
 * The headline invariant is `metrics(hybrid) <= metrics(greedy)` under the problem's lexicographic
 * comparator, for *every* problem the suite knows about — the F1–F15 semantics fixtures and the
 * benchmark shapes alike. That is not a quality aspiration, it is a structural guarantee: greedy's
 * own result is installed as the hybrid's initial incumbent and the fold only replaces an incumbent
 * with something strictly better. If this test fails, the guarantee has been broken, not missed.
 *
 * The rest of the file covers the ways the guarantee could be broken while still *looking* right:
 * re-assembling greedy under the hybrid's id (which must not perturb a metric), the tie rule that
 * keeps the greedy schedule when search finds nothing better, and superset monotonicity in the run
 * count.
 *
 * Cost discipline: the fixtures are tiny and get a deep sweep; the benchmark shapes are up to 248
 * matches and get a deliberately shallow one. The property is structural, so breadth across seeds
 * buys nothing here — the benchmark runner asserts the same property at production run counts.
 */

import { describe, expect, it } from "vitest";

import { compareIds, type SchedulingProblem, type Solution } from "./domain";
import { FIXTURES } from "./fixtures.test-helpers";
import { assertValidSolution } from "./invariant-harness.test-helpers";
import {
  buildSolution,
  compareMetrics,
  metricsOf,
  objectiveOrderOf,
  type SolutionMetrics,
} from "./metrics";
import { BENCH_INSTANCES } from "./benchmark/shapes";
import { greedySolver } from "./solvers/greedy";
import { graspSolver } from "./solvers/grasp";
import { hybridSolver } from "./solvers/hybrid";
import { DEFAULT_FRAGMENTATION_GAP_MINUTES, DEFAULT_SEED } from "./solvers/types";

const FIXTURE_SEEDS: readonly number[] = [DEFAULT_SEED, 7];
const SHAPE_SEEDS: readonly number[] = [DEFAULT_SEED];
const FIXTURE_RUNS: readonly number[] = [1, 5];
const SHAPE_RUNS: readonly number[] = [1, 3];
/**
 * Run counts for the monotonicity test, which needs at least three points to be meaningful. The
 * fixtures are small enough to afford the production run count; F2 is the exception at 368 matches,
 * which is why the shapes get the cheaper ladder.
 */
const FIXTURE_MONOTONIC_RUNS: readonly number[] = [1, 5, 25];
const SHAPE_MONOTONIC_RUNS: readonly number[] = [1, 3];

interface Case {
  id: string;
  problem: SchedulingProblem;
  /** Seeds the invariant sweep uses. */
  seeds: readonly number[];
  /** Run counts the invariant sweep uses. */
  runs: readonly number[];
  /** Run counts the monotonicity ladder uses, ascending. */
  monotonicRuns: readonly number[];
}

/** The fixture cases: small enough for a deeper sweep. */
function fixtureCases(): Case[] {
  return FIXTURES.map((fixture) => ({
    id: `fixture ${fixture.id}`,
    problem: fixture.problem,
    seeds: FIXTURE_SEEDS,
    runs: FIXTURE_RUNS,
    monotonicRuns: FIXTURE_MONOTONIC_RUNS,
  }));
}

/** The benchmark cases: up to 248 matches, so a deliberately shallow sweep. */
function shapeCases(): Case[] {
  return BENCH_INSTANCES.map((instance) => ({
    id: `shape ${instance.id}`,
    problem: instance.problem,
    seeds: SHAPE_SEEDS,
    runs: SHAPE_RUNS,
    monotonicRuns: SHAPE_MONOTONIC_RUNS,
  }));
}

function allCases(): Case[] {
  return [...fixtureCases(), ...shapeCases()];
}

/**
 * The comparison the invariant is stated in: `metricsOf` on both sides, the problem's own objective
 * order, one shared fragmentation gap. `> 0` means the first argument lost.
 */
function compare(
  problem: SchedulingProblem,
  left: Solution,
  right: Solution,
  gap = DEFAULT_FRAGMENTATION_GAP_MINUTES,
): number {
  return compareMetrics(
    metricsOf(problem, left, gap),
    metricsOf(problem, right, gap),
    objectiveOrderOf(problem),
  );
}

function greedyOf(problem: SchedulingProblem): Solution {
  return greedySolver.solve(problem, { seed: DEFAULT_SEED });
}

describe("hybrid is never worse than greedy", () => {
  it("holds for every semantics fixture", () => {
    const failures: string[] = [];
    for (const { id, problem, seeds, runs } of fixtureCases()) {
      const greedy = greedyOf(problem);
      for (const seed of seeds) {
        for (const runCount of runs) {
          const hybrid = hybridSolver.solve(problem, { seed, runs: runCount });
          if (compare(problem, hybrid, greedy) > 0)
            failures.push(`${id} seed=${seed} runs=${runCount}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("holds for every benchmark shape", () => {
    const failures: string[] = [];
    for (const { id, problem, seeds, runs } of shapeCases()) {
      const greedy = greedyOf(problem);
      for (const seed of seeds) {
        for (const runCount of runs) {
          const hybrid = hybridSolver.solve(problem, { seed, runs: runCount });
          if (compare(problem, hybrid, greedy) > 0)
            failures.push(`${id} seed=${seed} runs=${runCount}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("never loses to plain GRASP at the same run count", () => {
    // Both fold candidates through the same comparator, and the hybrid's pool is the GRASP pool plus
    // greedy, so it is the minimum over a superset. One run is enough to pin that, and it keeps this
    // test from doubling the cost of the sweep above.
    const failures: string[] = [];
    for (const { id, problem, seeds, runs } of allCases()) {
      for (const seed of seeds) {
        const runCount = runs[0]!;
        const hybrid = hybridSolver.solve(problem, { seed, runs: runCount });
        const grasp = graspSolver.solve(problem, { seed, runs: runCount });
        if (compare(problem, hybrid, grasp) > 0)
          failures.push(`${id} seed=${seed} runs=${runCount}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps greedy's schedule whenever a candidate only ties it", () => {
    // The tie rule is what makes the strategy monotone in a useful sense: turning runs up can only
    // add a better candidate, never swap a good schedule for an equally-good random one. When the
    // hybrid returns greedy's metrics, it must return greedy's *schedule*, not merely a schedule
    // that happens to score the same.
    const tied: string[] = [];
    const improved: string[] = [];
    for (const { id, problem } of allCases()) {
      const greedy = greedyOf(problem);
      const hybrid = hybridSolver.solve(problem, { seed: DEFAULT_SEED, runs: 3 });
      if (compare(problem, hybrid, greedy) === 0) {
        expect(hybrid.assignments, `${id} assignments`).toEqual(greedy.assignments);
        expect([...hybrid.unscheduled].sort(compareIds), `${id} unscheduled`).toEqual(
          [...greedy.unscheduled].sort(compareIds),
        );
        tied.push(id);
      } else {
        improved.push(id);
      }
    }
    // Both branches must be observed, or the tie rule would only be pinned in one regime.
    expect(tied.length).toBeGreaterThan(0);
    expect(improved.length).toBeGreaterThan(0);
  });

  it("re-assembling a schedule under another solver id changes no metric", () => {
    // `greedyIncumbent` re-assembles greedy's assignments under the hybrid's id. `buildSolution` is
    // pure in (problem, assignments, unscheduled, assembly), so that must be an identity on every
    // metric; otherwise the hybrid's floor would silently differ from the greedy result it claims
    // to dominate.
    for (const { id, problem } of allCases()) {
      const greedy = greedyOf(problem);
      const relabelled = buildSolution(problem, greedy.assignments, greedy.unscheduled, {
        solverId: "relabelled",
        runs: 1,
        seed: 0,
        deadlockReason: greedy.diagnostics.deadlockReason,
        fragmentationGapMinutes: DEFAULT_FRAGMENTATION_GAP_MINUTES,
      });
      expect(metricsOf(problem, relabelled), `${id} metrics`).toEqual(metricsOf(problem, greedy));
      expect(relabelled.diagnostics.solverId).toBe("relabelled");
      expect(relabelled.knownFinish).toBe(greedy.knownFinish);
      expect(relabelled.decisionFinish).toBe(greedy.decisionFinish);
      expect(relabelled.decisionResourceIdle).toBe(greedy.decisionResourceIdle);
    }
  });
});

describe("hybrid solver behaviour", () => {
  it("always reports itself as the strategy, whichever candidate wins", () => {
    for (const { problem } of allCases()) {
      const solution = hybridSolver.solve(problem, { seed: DEFAULT_SEED, runs: 1 });
      expect(solution.diagnostics.solverId).toBe("grasp-hybrid");
    }
  });

  it("returns a schedule that satisfies every hard invariant", () => {
    for (const { problem } of allCases()) {
      assertValidSolution(problem, hybridSolver.solve(problem, { seed: DEFAULT_SEED, runs: 2 }));
    }
  });

  it("is deterministic for a fixed seed and run count", () => {
    for (const { problem } of allCases()) {
      const first = hybridSolver.solve(problem, { seed: 4242, runs: 2 });
      const second = hybridSolver.solve(problem, { seed: 4242, runs: 2 });
      expect(second.assignments).toEqual(first.assignments);
      expect(second.unscheduled).toEqual(first.unscheduled);
    }
  });

  it("searches a superset as runs grow, so quality is monotone in the run count", () => {
    // Run `n` uses seed `baseSeed + n`, so a larger run count evaluates every seed a smaller one did
    // and adds to it. The best-of fold therefore cannot get worse. A violation means the fold or the
    // seed offset broke.
    const failures: string[] = [];
    for (const { id, problem, monotonicRuns } of allCases()) {
      const order = objectiveOrderOf(problem);
      let previous: SolutionMetrics | null = null;
      for (const runCount of monotonicRuns) {
        const metrics = metricsOf(
          problem,
          hybridSolver.solve(problem, { seed: 11, runs: runCount }),
        );
        if (previous && compareMetrics(metrics, previous, order) > 0) {
          failures.push(`${id} got worse at ${runCount} runs`);
        }
        previous = metrics;
      }
    }
    expect(failures).toEqual([]);
  });

  it("decides independently of the order the matches are supplied in", () => {
    const fixture = FIXTURES.find((candidate) => candidate.id === "F3")!.problem;
    const shuffled: SchedulingProblem = {
      ...fixture,
      matches: [...fixture.matches].sort((a, b) => compareIds(b.id, a.id)),
    };
    const first = hybridSolver.solve(fixture, { seed: 5, runs: 4 });
    const second = hybridSolver.solve(shuffled, { seed: 5, runs: 4 });
    expect(metricsOf(shuffled, second)).toEqual(metricsOf(fixture, first));
  });
});
