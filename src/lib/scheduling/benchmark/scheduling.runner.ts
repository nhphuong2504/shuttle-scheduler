/**
 * Runner for the scheduling-core benchmark.
 *
 * Deliberately *not* named `*.test.ts`: `vitest.config.ts` includes only `src/**\/*.test.ts`, so the
 * ordinary suite never pays for this, and `npm run bench:scheduling` runs it through
 * `vitest.benchmark.config.ts` instead. It runs as a single test so the whole measured sweep is one
 * pass/fail unit with a real timeout.
 *
 * Environment overrides, for calibrating on a slower machine without editing code:
 *   BENCH_REPS   timed repetitions per configuration (default 25)
 *   BENCH_SEEDS  number of base seeds to sample quality over (default 5)
 *   BENCH_ONLY   comma-separated instance ids to restrict the sweep
 *   BENCH_OUT    path to also write the markdown report to
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BENCH_CONFIGS,
  BENCH_SEEDS,
  allValid,
  compareObjective,
  formatReport,
  measureAll,
  measurementOf,
  monotonicityViolations,
  seedsBeatingGreedy,
} from "./harness";
import { BENCH_INSTANCES } from "./shapes";

const REPETITIONS = Number(process.env["BENCH_REPS"] ?? 25);
const SEED_COUNT = Number(process.env["BENCH_SEEDS"] ?? BENCH_SEEDS.length);
const SEEDS = BENCH_SEEDS.slice(0, Math.max(1, Math.min(SEED_COUNT, BENCH_SEEDS.length)));
const ONLY = (process.env["BENCH_ONLY"] ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const INSTANCES = ONLY.length
  ? BENCH_INSTANCES.filter((instance) => ONLY.includes(instance.id))
  : BENCH_INSTANCES;

/**
 * Writes the report in slices, yielding between them.
 *
 * The full report is a few hundred lines. Emitting it in one synchronous write starves vitest's
 * reporter heartbeat and the run ends in an `onTaskUpdate` timeout error, which reads as a failed
 * benchmark even though every assertion passed. Yielding between slices keeps the worker responsive.
 */
async function printChunked(text: string, linesPerChunk = 25): Promise<void> {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += linesPerChunk) {
    process.stdout.write(`${lines.slice(index, index + linesPerChunk).join("\n")}\n`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("generic scheduling core benchmark", () => {
  it(
    "compares greedy against hybrid GRASP at 1, 5, 10 and 25 runs",
    async () => {
      const startedAt = performance.now();
      const measurements = await measureAll(INSTANCES, BENCH_CONFIGS, SEEDS, REPETITIONS);
      const elapsedSeconds = (performance.now() - startedAt) / 1000;

      const report = formatReport(measurements, INSTANCES, BENCH_CONFIGS, SEEDS, REPETITIONS);
      await printChunked(`\n${report}\nSweep took ${elapsedSeconds.toFixed(1)}s.`);

      const out = process.env["BENCH_OUT"];
      if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, `${report}\n`, "utf8");
        console.log(`\nReport written to ${out}`);
      }

      // The harness measures; these are the properties that must hold whatever the numbers say.
      // A failure here means a determinism or validity regression, not a slow solver.
      for (const measurement of measurements) {
        expect(
          measurement.deterministic,
          `${measurement.instanceId}/${measurement.label} determinism`,
        ).toBe(true);
        expect(
          allValid(measurement),
          `${measurement.instanceId}/${measurement.label} validity`,
        ).toBe(true);
      }
      expect(monotonicityViolations(measurements, INSTANCES, BENCH_CONFIGS)).toEqual([]);

      // The hybrid is defined as greedy's incumbent plus the search, so at production run counts it
      // must never lose to greedy on any seed. Checked here as well as in the unit suite because this
      // is where the run ladder is deep enough for the search to be capable of winning at all.
      for (const instance of INSTANCES) {
        const greedy = measurementOf(measurements, instance.id, "greedy");
        for (const config of BENCH_CONFIGS) {
          if (config.id === "greedy") continue;
          const hybrid = measurementOf(measurements, instance.id, config.id);
          hybrid.quality.forEach((row, seedIndex) => {
            expect(
              compareObjective(row.objective, greedy.quality[seedIndex]!.objective),
              `${instance.id}/${config.label} seed#${seedIndex} lost to greedy`,
            ).toBeLessThanOrEqual(0);
          });
        }
      }

      // Report the headline: how often the additional search actually changed the answer.
      console.log("Seeds where each hybrid beat greedy (out of " + SEEDS.length + "):");
      for (const instance of INSTANCES) {
        const cells = BENCH_CONFIGS.filter((config) => config.id !== "greedy").map(
          (config) => `${config.label} ${seedsBeatingGreedy(measurements, instance.id, config.id)}`,
        );
        console.log(`  ${instance.id}: ${cells.join(", ")}`);
      }
    },
    30 * 60 * 1000,
  );
});
