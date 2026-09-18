/**
 * Solver registry and dispatcher.
 *
 * Interchangeability is a registry fact: greedy, GRASP and any future strategy are looked up by id
 * and run over the same pure problem. `solve()` validates the problem first, so invalid input
 * surfaces as a construction error rather than as a phantom `unscheduled` entry.
 */

import type { SchedulingProblem, Solution } from "../domain";
import { assertValidProblem } from "../preflight";
import { compareIds } from "../domain";
import { greedySolver } from "./greedy";
import { graspSolver } from "./grasp";
import {
  DEFAULT_SOLVER_ID,
  type Solver,
  type SolverRunOptions,
} from "./types";

const registry = new Map<string, Solver>();

/** Registers a solver strategy. A duplicate id throws rather than silently replacing. */
export function registerSolver(solver: Solver): void {
  if (registry.has(solver.id)) {
    throw new Error(`Solver "${solver.id}" is already registered.`);
  }
  registry.set(solver.id, solver);
}

/** Looks up a solver. An unknown id throws and names the ids that do exist. */
export function getSolver(id: string): Solver {
  const solver = registry.get(id);
  if (!solver) {
    const known = [...registry.keys()].sort(compareIds);
    throw new Error(
      `Unknown solver "${id}". Known solvers: ${known.length ? known.join(", ") : "(none)"}.`,
    );
  }
  return solver;
}

/** Every registered solver, canonically ordered by id. */
export function listSolvers(): Solver[] {
  return [...registry.values()].sort((a, b) => compareIds(a.id, b.id));
}

/** True when an id is registered, without throwing. */
export function hasSolver(id: string): boolean {
  return registry.has(id);
}

/**
 * Validates the problem, then runs the requested strategy. Invalid input throws
 * `ProblemValidationError` before any solver runs.
 */
export function solve(
  problem: SchedulingProblem,
  solverId: string = DEFAULT_SOLVER_ID,
  options: SolverRunOptions = {},
): Solution {
  assertValidProblem(problem);
  return getSolver(solverId).solve(problem, options);
}

registerSolver(greedySolver);
registerSolver(graspSolver);

export { greedySolver, graspSolver };
export { DEFAULT_SOLVER_ID } from "./types";
export type { Solver, SolverRunOptions } from "./types";
