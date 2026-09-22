#!/usr/bin/env node
/**
 * Predicts how the browser suite divides across N shards, from measured durations.
 *
 * ## Why this exists
 *
 * The browser job is CPU-bound, not worker-bound. `ubuntu-latest` has 4 vCPU and a
 * Playwright worker drives a whole Chromium, so 2 workers already saturate the runner:
 * raising it to 4 measured 1132s against 1141s (no gain), while inflating per-test cost
 * 1.9x and failing 20 tests on contention. Wall time therefore has to come from more
 * runners, not more workers.
 *
 * Splitting across runners is what this script plans. It exists because the right shard
 * count is not obvious and intuition has been wrong here twice:
 *
 *   - Shards split by test *count*, not duration, so they land unevenly. At N=2 the split
 *     measured 23.1 min of work against 13.5 min - 58% even - and the wall time is set by
 *     the slower shard, so the imbalance is the entire difference between 12.9 minutes and
 *     the ~10 minutes an even split would give.
 *   - More shards is not monotonically better. N=6 measured *worse* than N=5 (14.0 min on
 *     its slowest shard against 11.2) because finer count-based splits shuffle the heavy
 *     specs together.
 *   - Fewer shards is not cheaper. Total runner minutes are `N x wall`, so an imbalanced
 *     small N can bill more than a balanced larger one: N=3 was predicted at 29.5 minutes
 *     against N=4's 28.1, while also being slower.
 *
 * Because the split is deterministic and durations are recorded, the outcome is
 * predictable to within a few percent - N=2 predicted 12.5 minutes against 12.9 measured.
 * That is what makes this worth running before changing a shard count, and worth
 * re-running after adding a spec file, since a new file reshuffles every shard boundary.
 *
 * ## What it needs
 *
 * One or more Playwright JSON reports from a real run - the one `npm run test:e2e` writes.
 * It reads durations from them; it cannot predict from a listing alone.
 *
 * Accepting several matters more than it looks: once the browser job is sharded, no single
 * artifact contains the whole suite. Each runner uploads its own report, so planning from
 * the union is the only way to see the full picture. A single-shard report silently
 * predicts nonsense - it looked like several shards "would run nothing" purely because
 * their tests were in the other file.
 *
 * Usage:
 *   npm run ci:shard-plan                  # table for 2..6 shards, from the last local run
 *   npm run ci:shard-plan -- --max 8       # widen the search
 *   npm run ci:shard-plan -- --report a.json --report b.json   # union of shard artifacts
 *
 * The `--list` calls below explicitly override the reporter. Without that, the configured
 * JSON reporter writes a result-less report over the very file this script reads, which is
 * how one earlier experiment destroyed its own input and reported that a green suite had
 * 148 tests that "produced no result".
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Stated because they are measured properties of the CI runner, not universal constants.
 *
 * `WORKERS_PER_SHARD` is 2 because 2 saturates a 4-vCPU runner - see the note above.
 * `SETUP_MIN` is the fixed per-run cost: checkout, `npm ci` (18s) and
 * `playwright install --with-deps chromium` (24s), measured from a real job.
 */
const WORKERS_PER_SHARD = 2;
const SETUP_MIN = 0.9;

function parseArgs(argv) {
  const reports = [];
  let max = 6;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--report" && argv[index + 1]) reports.push(argv[index + 1]);
    if (argv[index] === "--max" && argv[index + 1]) max = Number(argv[index + 1]);
  }

  return { reports: reports.length > 0 ? reports : ["test-results/e2e-report.json"], max };
}

/**
 * Map of `"<file>::<suite › … › title>"` to measured duration in ms.
 *
 * The suite path is rebuilt rather than taken from a field, because the JSON nests each
 * test under its `describe` blocks and the listing prints exactly that chain.
 *
 * A file-level suite carries the spec path as its title. It is excluded from the path: the
 * listing shows `<file>:<line>:<col> › <title>`, so including the filename a second time
 * makes every key miss. That bug is why an earlier version of this analysis matched 0 of
 * 297 tests.
 */
function durationsFromReport(path) {
  const durations = new Map();

  function walk(suite, path) {
    const isFileSuite = /\.spec\.tsx?$/.test(suite.title ?? "");
    const here = suite.title && !isFileSuite ? [...path, suite.title] : path;

    for (const spec of suite.specs ?? []) {
      const file = (spec.file ?? "").split("/").pop();
      let ms = 0;
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) ms += result.duration ?? 0;
      }
      durations.set(`${file}::${[...here, spec.title].join(" › ")}`, ms);
    }

    for (const child of suite.suites ?? []) walk(child, here);
  }

  for (const child of JSON.parse(readFileSync(path, "utf8")).suites ?? []) walk(child, []);
  return durations;
}

/** The tests Playwright would run for one shard, with their recorded durations. */
function shardWork(durations, shard, total) {
  const output = execFileSync(
    "npx",
    ["playwright", "test", "--list", `--shard=${shard}/${total}`, "--reporter=list"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );

  const work = [];
  let unmatched = 0;

  for (const line of output.split("\n")) {
    const listed = line.match(/^\s*\[chromium\] › (.*)$/);
    if (!listed) continue;
    const index = listed[1].indexOf(" › ");
    if (index === -1) continue;

    const file = listed[1].slice(0, index).replace(/:[0-9]+:[0-9]+$/, "").split("/").pop();
    const duration = durations.get(`${file}::${listed[1].slice(index + 3)}`);
    if (duration === undefined) unmatched += 1;
    else work.push(duration);
  }

  return { work, unmatched };
}

function main() {
  const { reports, max } = parseArgs(process.argv.slice(2));

  const durations = new Map();
  for (const report of reports) {
    try {
      for (const [key, ms] of durationsFromReport(report)) {
        // Union across shard reports. Shards partition the suite, so keys should not
        // collide; taking the max keeps the result deterministic if one ever does.
        durations.set(key, Math.max(durations.get(key) ?? 0, ms));
      }
    } catch (error) {
      console.error(
        `shard-plan: could not read a Playwright report at ${report}.\n` +
          "Run `npm run test:e2e` first - planning needs measured durations.\n" +
          `Underlying error: ${error.message}`,
      );
      process.exit(2);
    }
  }

  if (durations.size === 0) {
    console.error(`shard-plan: no tests found in ${reports.join(", ")}.`);
    process.exit(2);
  }

  console.log(`shard-plan: ${durations.size} recorded tests from ${reports.join(", ")}`);
  console.log(
    `Assumes ${WORKERS_PER_SHARD} workers per shard and ${SETUP_MIN * 60}s of fixed setup.\n`,
  );
  console.log("  N   work per shard (min)                wall    total runner-min   evenness");

  let best = null;
  let cheapest = null;
  let total = 0;

  for (let n = 2; n <= max; n += 1) {
    const shards = [];
    for (let shard = 1; shard <= n; shard += 1) {
      const { work, unmatched } = shardWork(durations, shard, n);
      if (unmatched > 0) {
        console.error(`  shard ${shard}/${n}: ${unmatched} listed test(s) had no recorded duration`);
      }
      shards.push(work.reduce((sum, ms) => sum + ms, 0));
      total += work.length;
    }

    const slowest = Math.max(...shards);
    const fastest = Math.min(...shards);
    const wall = slowest / 1000 / 60 / WORKERS_PER_SHARD + SETUP_MIN;

    if (fastest === 0) {
      // A shard with no work means the argument is wrong, not that it is instant.
      console.error(`  N=${n}: at least one shard would run nothing - check the listing`);
      continue;
    }

    console.log(
      `  ${n}   ${shards
        .map((ms) => (ms / 1000 / 60).toFixed(1))
        .join(", ")
        .padEnd(34)}${(slowest / 1000 / 60).toFixed(1).padStart(5)}` +
        `${wall.toFixed(1).padStart(10)}${(wall * n).toFixed(1).padStart(15)}` +
        `${`${((fastest / slowest) * 100).toFixed(0)}%`.padStart(9)}`,
    );

    if (best === null || wall < best.wall) best = { n, wall, minutes: wall * n };
    if (cheapest === null || wall * n < cheapest.minutes) {
      cheapest = { n, wall, minutes: wall * n };
    }
  }

  if (best) {
    console.log(
      `\nFastest wall: N=${best.n} at ~${best.wall.toFixed(1)} min wall, ` +
        `~${best.minutes.toFixed(1)} total runner minutes.`,
    );
  }
  if (cheapest && cheapest.n !== best?.n) {
    console.log(
      `Cheapest:     N=${cheapest.n} at ~${cheapest.minutes.toFixed(1)} total runner ` +
        `minutes, ~${cheapest.wall.toFixed(1)} min wall.`,
    );
  }

  console.log(
    "\nWall time is set by the slowest shard, so the thing to minimise is the largest\n" +
      "shard - not the shard count, and not the evenness. Total minutes are `N x wall`,\n" +
      "so an imbalanced small N can bill more than a balanced larger one. Pick between\n" +
      "the two above on whether wall time or billed minutes matter more.",
  );
}

main();
