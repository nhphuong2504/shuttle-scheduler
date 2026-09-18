/**
 * Benchmark harness for the generic scheduling core.
 *
 * The point is a decision: does the current 75-run GRASP default earn its runtime over greedy, or
 * over a much cheaper GRASP? To answer that honestly the harness separates two things that are easy
 * to conflate:
 *
 *   - **Quality** is measured across several base seeds, one run each. GRASP is deterministic at a
 *     fixed seed, so a single seed would report one sample of a distribution as if it were the
 *     answer. The seeds are spaced wider than the largest run count so the seed ranges each config
 *     explores do not overlap, which is what makes the samples comparable.
 *   - **Runtime** is measured as repeated runs at one fixed seed, because runtime depends on the
 *     problem shape and the run count, not on the seed. Repetitions give a distribution, so median
 *     and p95 are reported rather than a single flattering number.
 *
 * Quality is monotone in the run count *by construction*: `runs = n` explores seeds `base..base+n-1`
 * and keeps the best valid one, so `runs = 25` searches a strict superset of `runs = 5`. The harness
 * asserts that monotonicity (`monotonicityViolations`) and otherwise reports how much the extra
 * search actually buys and what it costs, which is the part that is not guaranteed.
 */

import { validateSolution } from "../constraints";
import type { SchedulingProblem, Solution } from "../domain";
import { solve } from "../solvers";
import { hybridSolver } from "../solvers/hybrid";
import type { SolverRunOptions } from "../solvers/types";
import { DEFAULT_SEED } from "../solvers/types";
import type { BenchInstance } from "./shapes";

/** One solver configuration under test. `runs` is 0 for strategies that ignore it. */
export interface ConfigSpec {
  id: string;
  label: string;
  solverId: string;
  runs: number;
  options: SolverRunOptions;
}

/**
 * The comparison set: greedy, and the greedy-seeded hybrid at 1 / 5 / 10 / 25 runs.
 *
 * Greedy is the incumbent the hybrid must never lose to, so it is the baseline every other row is
 * read against. The run ladder exists to find the smallest count at which more search stops paying.
 */
export const BENCH_CONFIGS: readonly ConfigSpec[] = [
  { id: "greedy", label: "greedy", solverId: "greedy", runs: 0, options: { seed: DEFAULT_SEED } },
  ...[1, 5, 10, 25].map((runs) => ({
    id: `hybrid-${runs}`,
    label: `hybrid x${runs}`,
    solverId: hybridSolver.id,
    runs,
    options: { seed: DEFAULT_SEED, runs },
  })),
];

/**
 * Base seeds. Spaced 1000 apart, far wider than the largest run count, so the seed ranges the
 * configs explore stay disjoint and the per-seed quality samples are not the same runs twice.
 */
export const BENCH_SEEDS: readonly number[] = [
  20_260_912, 20_261_912, 20_262_912, 20_263_912, 20_264_912,
];

export interface QualityRow {
  unscheduled: number;
  afterCutoff: number;
  makespan: number;
  resourceIdle: number;
  knownOverrunMinutes: number;
  /** The lexicographic objective tuple, in `DEFAULT_OBJECTIVE_ORDER`. Lower is better. */
  objective: number[];
  valid: boolean;
}

export interface ConfigMeasurement {
  instanceId: string;
  configId: string;
  label: string;
  /** One quality row per base seed, in `seeds` order. */
  quality: QualityRow[];
  /** Wall-clock milliseconds per timed repetition, at `seeds[0]`. */
  timings: number[];
  /** Every timed repetition produced the same decision. False would be a determinism bug. */
  deterministic: boolean;
}

/** Nearest-rank percentile over an ascending slice. `p` is a fraction, e.g. 0.95. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return Number.NaN;
  const ascending = [...values].sort((a, b) => a - b);
  const index = Math.min(ascending.length - 1, Math.max(0, Math.ceil(p * ascending.length) - 1));
  return ascending[index]!;
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/** Calls the collector between repetitions when the runtime exposes one (`--expose-gc`). */
function maybeCollect(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

function qualityOf(problem: SchedulingProblem, solution: Solution): QualityRow {
  return {
    unscheduled: solution.unscheduled.length,
    afterCutoff: solution.decisionAfterCutoff,
    makespan: solution.diagnostics.makespanMinutes,
    resourceIdle: solution.decisionResourceIdle,
    knownOverrunMinutes: solution.knownOverrunMinutes,
    objective: [...solution.diagnostics.winningScore],
    valid: validateSolution(problem, solution).length === 0,
  };
}

/** Enough of a solution to notice a determinism regression without comparing whole solutions. */
function signatureOf(problem: SchedulingProblem, solution: Solution): string {
  return [
    solution.unscheduled.length,
    solution.assignments.length,
    solution.diagnostics.winningScore.join(","),
    validateSolution(problem, solution).length,
  ].join("|");
}

/**
 * Yields to the event loop.
 *
 * The sweep is CPU-bound: one `solve()` is synchronous and can take over a second on the large shape.
 * A tight loop of them never returns to the event loop, so the worker cannot service the test
 * runner's RPC heartbeat and vitest ends an otherwise passing run with an `onTaskUpdate` timeout.
 * Yielding between solves keeps the runner responsive. It happens outside every timed region, so it
 * cannot distort a measurement.
 */
async function yieldToRunner(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

export async function measureInstance(
  instance: BenchInstance,
  config: ConfigSpec,
  seeds: readonly number[] = BENCH_SEEDS,
  repetitions = 25,
): Promise<ConfigMeasurement> {
  const { problem } = instance;

  // Quality: one run per seed, so this is a sample of what the config produces, not one lucky draw.
  const quality: QualityRow[] = [];
  for (const seed of seeds) {
    quality.push(qualityOf(problem, solve(problem, config.solverId, { ...config.options, seed })));
    await yieldToRunner();
  }

  // Runtime: an untimed warm-up first, so JIT compilation is not billed to the first sample.
  const timingSeed = seeds[0]!;
  solve(problem, config.solverId, { ...config.options, seed: timingSeed });

  const timings: number[] = [];
  let deterministic = true;
  let firstSignature: string | null = null;
  for (let rep = 0; rep < repetitions; rep++) {
    maybeCollect();
    const started = performance.now();
    const solution = solve(problem, config.solverId, { ...config.options, seed: timingSeed });
    timings.push(performance.now() - started);
    const signature = signatureOf(problem, solution);
    firstSignature ??= signature;
    if (signature !== firstSignature) deterministic = false;
    await yieldToRunner();
  }

  return {
    instanceId: instance.id,
    configId: config.id,
    label: config.label,
    quality,
    timings,
    deterministic,
  };
}

export async function measureAll(
  instances: readonly BenchInstance[],
  configs: readonly ConfigSpec[] = BENCH_CONFIGS,
  seeds: readonly number[] = BENCH_SEEDS,
  repetitions = 25,
): Promise<ConfigMeasurement[]> {
  const measurements: ConfigMeasurement[] = [];
  for (const instance of instances) {
    for (const config of configs) {
      measurements.push(await measureInstance(instance, config, seeds, repetitions));
    }
  }
  return measurements;
}

export function measurementOf(
  measurements: readonly ConfigMeasurement[],
  instanceId: string,
  configId: string,
): ConfigMeasurement {
  const found = measurements.find((m) => m.instanceId === instanceId && m.configId === configId);
  if (!found) throw new Error(`No measurement for ${instanceId}/${configId}.`);
  return found;
}

/** Median across seeds of one numeric quality metric. */
export function medianMetric(measurement: ConfigMeasurement, key: keyof QualityRow): number {
  const values = measurement.quality.map((row) => row[key]);
  if (values.some((value) => typeof value !== "number")) {
    throw new Error(`Metric ${String(key)} is not numeric.`);
  }
  return median(values as number[]);
}

/** Worst across seeds of one numeric quality metric, which is what an unlucky seed would show. */
export function worstMetric(measurement: ConfigMeasurement, key: keyof QualityRow): number {
  return Math.max(...measurement.quality.map((row) => row[key] as number));
}

/** True when every measured solution satisfied every hard invariant. */
export function allValid(measurement: ConfigMeasurement): boolean {
  return measurement.quality.every((row) => row.valid);
}

/** -1 when `a` is better, 1 when `b` is better, 0 on a tie. Lexicographic, lower is better. */
export function compareObjective(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Seeds on which a configuration with more runs failed to match or beat the same strategy with
 * fewer runs. Within one strategy quality is monotone in the run count by construction, so any entry
 * here means the selection or the seed offset is broken, not that the search did badly.
 *
 * Configurations are grouped by `solverId`, so adding a strategy to the comparison set needs no
 * change here — greedy is excluded automatically because it declares `runs: 0`.
 */
export function monotonicityViolations(
  measurements: readonly ConfigMeasurement[],
  instances: readonly BenchInstance[],
  configs: readonly ConfigSpec[] = BENCH_CONFIGS,
): string[] {
  const bySolver = new Map<string, ConfigSpec[]>();
  for (const config of configs) {
    if (config.runs <= 0) continue;
    const group = bySolver.get(config.solverId) ?? [];
    group.push(config);
    bySolver.set(config.solverId, group);
  }

  const violations: string[] = [];
  for (const instance of instances) {
    for (const [solverId, group] of bySolver) {
      const ascending = [...group].sort((a, b) => a.runs - b.runs);
      for (let i = 1; i < ascending.length; i++) {
        const cheaper = measurementOf(measurements, instance.id, ascending[i - 1]!.id);
        const dearer = measurementOf(measurements, instance.id, ascending[i]!.id);
        dearer.quality.forEach((row, seedIndex) => {
          const reference = cheaper.quality[seedIndex]!;
          if (compareObjective(row.objective, reference.objective) > 0) {
            violations.push(
              `${instance.id} seed#${seedIndex}: ${solverId} x${ascending[i]!.runs} scored worse ` +
                `than x${ascending[i - 1]!.runs}`,
            );
          }
        });
      }
    }
  }
  return violations;
}

/**
 * Seeds on which a configuration strictly beat greedy. Zero means the extra search bought nothing —
 * the hybrid simply returned greedy's schedule, which is exactly what the tie rule is for.
 */
export function seedsBeatingGreedy(
  measurements: readonly ConfigMeasurement[],
  instanceId: string,
  configId: string,
): number {
  const baseline = measurementOf(measurements, instanceId, "greedy");
  const config = measurementOf(measurements, instanceId, configId);
  let count = 0;
  config.quality.forEach((row, seedIndex) => {
    const greedy = baseline.quality[seedIndex]!;
    if (compareObjective(row.objective, greedy.objective) < 0) count++;
  });
  return count;
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

function fixed(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function delta(before: number, after: number): string {
  const change = after - before;
  if (Math.abs(change) < 1e-9) return "=";
  const rounded = Math.round(change * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function runtimeRow(measurement: ConfigMeasurement): string {
  const timings = measurement.timings;
  return [
    `| ${measurement.label}`,
    `| ${fixed(median(timings))}`,
    `| ${fixed(percentile(timings, 0.95))}`,
    `| ${fixed(Math.min(...timings))}`,
    `| ${fixed(Math.max(...timings))} |`,
  ].join(" ");
}

/**
 * The report: shape inventory, then per-instance quality and runtime, then how much of greedy's
 * result the search actually improves on, which is the question the benchmark exists to answer.
 */
export function formatReport(
  measurements: readonly ConfigMeasurement[],
  instances: readonly BenchInstance[],
  configs: readonly ConfigSpec[] = BENCH_CONFIGS,
  seeds: readonly number[] = BENCH_SEEDS,
  repetitions = 25,
): string {
  // Only report configurations that were actually measured, so a narrowed sweep still formats.
  const measured = configs.filter((config) =>
    measurements.some((measurement) => measurement.configId === config.id),
  );
  const lines: string[] = [];
  lines.push("# Generic scheduling core — solver benchmark");
  lines.push("");
  lines.push(
    `Quality median across ${seeds.length} base seeds (spaced ${seeds[1]! - seeds[0]!} so the explored ` +
      `seed ranges stay disjoint); runtime over ${repetitions} repetitions at seed ${seeds[0]!}. ` +
      "All times in ms. Lower is better for every metric.",
  );

  lines.push("");
  lines.push("## Shapes");
  lines.push("");
  lines.push(
    "| instance | matches | solver | fixed | anchors | resources | window (min) | description |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const instance of instances) {
    lines.push(
      `| ${instance.id} | ${instance.matchCount} | ${instance.solverMatchCount} | ${instance.fixedMatchCount} | ` +
        `${instance.anchorCount} | ${instance.resourceCount} | ${instance.planningMinutes} | ${instance.description} |`,
    );
  }

  for (const instance of instances) {
    lines.push("");
    lines.push(`## ${instance.id}`);
    lines.push("");
    lines.push(
      "| solver | unsched | unsched·worst | afterCutoff | makespan | idle | median ms | p95 ms | max ms | valid |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const config of measured) {
      const measurement = measurementOf(measurements, instance.id, config.id);
      lines.push(
        [
          `| ${measurement.label}`,
          `| ${fixed(medianMetric(measurement, "unscheduled"), 0)}`,
          `| ${fixed(worstMetric(measurement, "unscheduled"), 0)}`,
          `| ${fixed(medianMetric(measurement, "afterCutoff"))}`,
          `| ${fixed(medianMetric(measurement, "makespan"))}`,
          `| ${fixed(medianMetric(measurement, "resourceIdle"))}`,
          `| ${fixed(median(measurement.timings))}`,
          `| ${fixed(percentile(measurement.timings, 0.95))}`,
          `| ${fixed(Math.max(...measurement.timings))}`,
          `| ${allValid(measurement) ? "yes" : "NO"} |`,
        ].join(" "),
      );
    }
  }

  lines.push("");
  lines.push("## Does the search earn its runtime?");
  lines.push("");
  lines.push(
    `How many of the ${seeds.length} base seeds each configuration strictly beat greedy on. \`0\` means ` +
      "the extra search changed nothing the objective cares about and the hybrid returned greedy's own " +
      "schedule, which is the tie rule working as designed.",
  );
  lines.push("");
  lines.push(
    "| instance | solver | median unsched / late / span | seeds beating greedy | ms median | ms p95 |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const instance of instances) {
    const greedy = measurementOf(measurements, instance.id, "greedy");
    lines.push(
      [
        `| ${instance.id}`,
        "| greedy",
        `| ${fixed(medianMetric(greedy, "unscheduled"), 0)} / ${fixed(medianMetric(greedy, "afterCutoff"))} / ${fixed(medianMetric(greedy, "makespan"))}`,
        "| — (baseline)",
        `| ${fixed(median(greedy.timings))}`,
        `| ${fixed(percentile(greedy.timings, 0.95))} |`,
      ].join(" "),
    );
    for (const config of measured) {
      if (config.id === "greedy") continue;
      const measurement = measurementOf(measurements, instance.id, config.id);
      lines.push(
        [
          `| ${instance.id}`,
          `| ${measurement.label}`,
          `| ${fixed(medianMetric(measurement, "unscheduled"), 0)} / ${fixed(medianMetric(measurement, "afterCutoff"))} / ${fixed(medianMetric(measurement, "makespan"))}`,
          `| ${seedsBeatingGreedy(measurements, instance.id, config.id)}/${seeds.length}`,
          `| ${fixed(median(measurement.timings))}`,
          `| ${fixed(percentile(measurement.timings, 0.95))} |`,
        ].join(" "),
      );
    }
  }

  lines.push("");
  lines.push("## What the extra runs buy");
  lines.push("");
  lines.push(
    "Median change in each metric, and the runtime cost of going from one configuration to the next. " +
      "`unsched` and `afterCutoff` are the two highest-priority criteria, so a `=` there means the " +
      "extra search changed nothing that the objective actually cares about.",
  );
  lines.push("");
  const pairs: Array<[string, string]> = [
    ...measured
      .slice(1)
      .map((config, index) => [measured[index]!.id, config.id] as [string, string]),
    [measured[0]!.id, measured[measured.length - 1]!.id],
  ];
  lines.push(
    "| instance | change | unsched | afterCutoff | makespan | idle | ms median | ms p95 |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const instance of instances) {
    for (const [fromId, toId] of pairs) {
      const from = measurementOf(measurements, instance.id, fromId);
      const to = measurementOf(measurements, instance.id, toId);
      lines.push(
        [
          `| ${instance.id}`,
          `| ${from.label} → ${to.label}`,
          `| ${delta(medianMetric(from, "unscheduled"), medianMetric(to, "unscheduled"))}`,
          `| ${delta(medianMetric(from, "afterCutoff"), medianMetric(to, "afterCutoff"))}`,
          `| ${delta(medianMetric(from, "makespan"), medianMetric(to, "makespan"))}`,
          `| ${delta(medianMetric(from, "resourceIdle"), medianMetric(to, "resourceIdle"))}`,
          `| ${delta(median(from.timings), median(to.timings))}`,
          `| ${delta(percentile(from.timings, 0.95), percentile(to.timings, 0.95))} |`,
        ].join(" "),
      );
    }
  }

  lines.push("");
  lines.push("## Per-seed quality");
  lines.push("");
  lines.push(
    "The objective tuple for every configuration and seed, so a median cannot hide a split.",
  );
  lines.push("");
  lines.push(`| instance | solver | ${seeds.map((seed) => `s${seed}`).join(" | ")} |`);
  lines.push(`| --- | --- | ${seeds.map(() => "---").join(" | ")} |`);
  for (const instance of instances) {
    for (const config of measured) {
      const measurement = measurementOf(measurements, instance.id, config.id);
      const cells = measurement.quality.map((row) => row.objective.join("/"));
      lines.push(`| ${instance.id} | ${measurement.label} | ${cells.join(" | ")} |`);
    }
  }

  const violations = monotonicityViolations(measurements, instances, measured);
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push(
    `- Deterministic across all timed repetitions: ${measurements.every((m) => m.deterministic) ? "yes" : "NO"}`,
  );
  lines.push(
    `- Every measured solution passed \`validateSolution\`: ${measurements.every(allValid) ? "yes" : "NO"}`,
  );
  lines.push(
    `- Quality monotone in the run count, per strategy: ${violations.length ? `NO (${violations.length} violations)` : "yes"}`,
  );
  for (const violation of violations.slice(0, 10)) lines.push(`  - ${violation}`);

  return lines.join("\n");
}
