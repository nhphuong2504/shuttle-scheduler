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

/** The legacy defaults, pinned so the same tournament and seed stay reproducible. */
export const DEFAULT_SOLVER_ID = "grasp";
export const DEFAULT_SEED = 20_260_912;
export const DEFAULT_RUNS = 75;
export const DEFAULT_RCL_SIZE = 4;
export const DEFAULT_FRAGMENTATION_GAP_MINUTES = 30;

export const DEFAULT_SOLVER_RUN_OPTIONS: Required<
  Pick<SolverRunOptions, "seed" | "runs" | "rclSize" | "fragmentationGapMinutes" | "debugTrace">
> = {
  seed: DEFAULT_SEED,
  runs: DEFAULT_RUNS,
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
