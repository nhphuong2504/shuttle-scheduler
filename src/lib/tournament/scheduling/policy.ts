/**
 * Scheduling policy: objective order, solver selection and search options.
 *
 * This is where "which strategy" and "how hard to search" live. Neither the core nor the sport
 * knows the other's opinion, which is what makes the solvers interchangeable.
 */

import {
  DEFAULT_FRAGMENTATION_GAP_MINUTES,
  DEFAULT_OBJECTIVE_ORDER,
  DEFAULT_RCL_SIZE,
  DEFAULT_RUNS,
  DEFAULT_SEED,
  DEFAULT_SOLVER_ID,
  type SchedulingPolicy,
  type SolverRunOptions,
} from "@/lib/scheduling";

export type { SchedulingPolicy, SolverSelection } from "@/lib/scheduling";

/** Search knobs the day planners accept, mapped onto `SolverRunOptions` here. */
export interface DayOneSchedulerOptions {
  categoryFragmentationGapMinutes?: number | undefined;
  rclSize?: number | undefined;
  graspRuns?: number | undefined;
  seed?: number | undefined;
  debugTrace?: boolean | undefined;
  maxIterationsPerRun?: number | undefined;
}

/**
 * The default policy. Options that are absent keep the pinned legacy constants, so a tournament
 * replanned with the same seed stays reproducible.
 */
export function defaultSchedulingPolicy(options?: DayOneSchedulerOptions): SchedulingPolicy {
  const solverOptions: SolverRunOptions = {
    seed: DEFAULT_SEED,
    runs: DEFAULT_RUNS,
    rclSize: DEFAULT_RCL_SIZE,
    fragmentationGapMinutes: DEFAULT_FRAGMENTATION_GAP_MINUTES,
    debugTrace: false,
    ...(options?.seed == null ? {} : { seed: options.seed }),
    ...(options?.graspRuns == null ? {} : { runs: options.graspRuns }),
    ...(options?.rclSize == null ? {} : { rclSize: options.rclSize }),
    ...(options?.categoryFragmentationGapMinutes == null
      ? {}
      : { fragmentationGapMinutes: options.categoryFragmentationGapMinutes }),
    ...(options?.debugTrace == null ? {} : { debugTrace: options.debugTrace }),
    ...(options?.maxIterationsPerRun == null
      ? {}
      : { maxIterationsPerRun: options.maxIterationsPerRun }),
  };
  return {
    id: "badminton-default",
    objective: DEFAULT_OBJECTIVE_ORDER,
    solvers: { default: DEFAULT_SOLVER_ID },
    solverOptions,
  };
}
