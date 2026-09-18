/**
 * The solver seam. Greedy, GRASP and any future strategy implement `Solver` over the same pure
 * `SchedulingProblem` and are interchangeable through the registry.
 */

import type { SchedulingProblem, Solution } from "../domain";

export interface SolverRunOptions {
  seed?: number | undefined;
  runs?: number | undefined;
  rclSize?: number | undefined;
  fragmentationGapMinutes?: number | undefined;
  debugTrace?: boolean | undefined;
  maxIterationsPerRun?: number | undefined;
}

export interface Solver {
  id: string;
  name: string;
  solve(problem: SchedulingProblem, options: SolverRunOptions): Solution;
}

/**
 * The default strategy. The benchmark in `.benchmark/hybrid-core.md` is what moved this off plain
 * `grasp`: the hybrid matches the 25-run search on `unscheduled` and `afterCutoff` — the two
 * criteria the objective ranks first — on every shape and every seed, for a fraction of the time.
 * Greedy is the hybrid's incumbent, so this can only ever be at least as good as greedy.
 */
export const DEFAULT_SOLVER_ID = "grasp-hybrid";
export const DEFAULT_SEED = 20_260_912;
/** Plain GRASP's run count. Still the right default for a search that has no greedy floor. */
export const DEFAULT_RUNS = 75;
/**
 * The hybrid's run count. One construction is enough: the greedy incumbent already covers the case
 * extra runs used to buy, and the benchmark showed runs 2–25 change nothing the top criteria see.
 */
export const DEFAULT_HYBRID_RUNS = 1;
export const DEFAULT_RCL_SIZE = 4;
export const DEFAULT_FRAGMENTATION_GAP_MINUTES = 30;

/** The run options the default solver gets when a caller passes none. */
export const DEFAULT_SOLVER_RUN_OPTIONS: Required<
  Pick<SolverRunOptions, "seed" | "runs" | "rclSize" | "fragmentationGapMinutes" | "debugTrace">
> = {
  seed: DEFAULT_SEED,
  runs: DEFAULT_HYBRID_RUNS,
  rclSize: DEFAULT_RCL_SIZE,
  fragmentationGapMinutes: DEFAULT_FRAGMENTATION_GAP_MINUTES,
  debugTrace: false,
};

/** The legacy per-run iteration backstop, scaled by problem size. */
export function defaultMaxIterations(problem: SchedulingProblem): number {
  return problem.matches.length * Math.max(problem.resources.length, 1) * 6 + 500;
}

/** Mulberry32, the same generator the legacy GRASP used, so seeds stay comparable. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
