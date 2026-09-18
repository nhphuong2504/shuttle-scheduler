/**
 * Hybrid solver: the greedy result as a seeded incumbent, then GRASP constructions folded into it.
 *
 * The benchmark showed the reason this exists. GRASP searches only the solutions its own randomised
 * construction produces, and the greedy solution is not in that set: on the larger shapes greedy
 * finished the day measurably earlier and completed the same work, and no number of GRASP runs
 * closed the gap. Adding greedy as an initial incumbent makes the search strictly a *superset*, so
 * the hybrid can only ever match or beat greedy — and every extra run is a genuine attempt to beat
 * it rather than a chance of drifting away from it.
 *
 * The two strategies compose without either knowing about the other: the fold is `compareMetrics`
 * over `metricsOf`, the same comparator and the same metrics every solver is scored by, and the
 * greedy result is just the first candidate in the pool.
 *
 * Ties keep the incumbent. So the hybrid's output *is* the greedy schedule unless a GRASP candidate
 * strictly wins on the objective, which makes the strategy monotone in a useful sense: turning runs
 * up can only add a better candidate, never replace a good one with an equal one.
 *
 * Scope: `DEFAULT_SOLVER_ID` and `defaultSchedulingPolicy` both select this strategy at one run,
 * which is what the benchmark justified. Plain `grasp` stays registered and unchanged for callers
 * that ask for it by id.
 */

import { validateSolution } from "../constraints";
import type { SchedulingProblem, Solution } from "../domain";
import { buildSolution, metricsOf } from "../metrics";
import { greedySolver } from "./greedy";
import {
  baseSeedOf,
  graspSearchOptions,
  searchGrasp,
  unplacedFallback,
  type GraspSearchOptions,
  type SolverCandidate,
} from "./grasp";
import type { Solver, SolverRunOptions } from "./types";
import { DEFAULT_HYBRID_RUNS } from "./types";

/**
 * Runs greedy once and presents it as the initial incumbent.
 *
 * The result is re-assembled with the hybrid's own `solverId` so diagnostics name the strategy the
 * caller actually asked for. `buildSolution` is pure in
 * `(problem, assignments, unscheduled, assembly)`, so re-assembling the same assignments can only
 * change the reported identity — never a metric, and never the schedule itself. That matters here:
 * the whole invariant rests on the incumbent being scored by the same `metricsOf` as every GRASP
 * candidate, and re-assembling is what guarantees it is.
 *
 * A greedy solution that fails `validateSolution` is refused rather than installed as the
 * incumbent, so an invalid schedule can never become the hybrid's floor.
 */
function greedyIncumbent(
  problem: SchedulingProblem,
  options: SolverRunOptions,
  search: GraspSearchOptions,
  seed: number,
): SolverCandidate | null {
  const greedy = greedySolver.solve(problem, options);
  if (validateSolution(problem, greedy).length) return null;

  const solution = buildSolution(problem, greedy.assignments, greedy.unscheduled, {
    solverId: search.solverId,
    // The run budget actually spent, so diagnostics do not under-report it when greedy wins.
    runs: search.runs,
    seed,
    deadlockReason: greedy.diagnostics.deadlockReason,
    fragmentationGapMinutes: search.fragmentationGapMinutes,
  });
  return {
    solution,
    metrics: metricsOf(problem, solution, search.fragmentationGapMinutes),
    seed,
  };
}

function solveHybrid(problem: SchedulingProblem, options: SolverRunOptions): Solution {
  const search = graspSearchOptions(problem, options, hybridSolver.id, DEFAULT_HYBRID_RUNS);
  const baseSeed = baseSeedOf(options);

  const incumbent = greedyIncumbent(problem, options, search, baseSeed);
  const best = searchGrasp(problem, search, baseSeed, incumbent, () => false);

  // Only reachable when greedy was invalid *and* no GRASP run produced a valid solution.
  return best?.solution ?? unplacedFallback(problem, search, baseSeed);
}

export const hybridSolver: Solver = {
  id: "grasp-hybrid",
  name: "GRASP, seeded with greedy",
  solve: solveHybrid,
};
