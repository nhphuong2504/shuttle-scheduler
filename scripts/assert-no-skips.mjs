#!/usr/bin/env node
/**
 * Fails when a Playwright run contained any skipped test.
 *
 * ## Why this exists
 *
 * A skip and a pass are the same thing in almost every summary a human reads. Playwright
 * prints "4 passed, 4 skipped", and a reader under time pressure sees "8, all fine". That
 * was not hypothetical: the staff-surface suite skipped itself whenever a recorded session
 * was absent, so the four tests covering the surfaces this project exists to get right
 * could report green having never rendered once. The skip was honest, individually
 * reasonable, and structurally indistinguishable from coverage.
 *
 * Making the suite hermetic removed the reason those skips happened. This guard removes
 * the *possibility* of it going unnoticed again, including for a skip introduced later for
 * a reason nobody anticipated.
 *
 * ## How it works
 *
 * It reads the JSON report the Playwright config always writes and walks every spec, suite
 * and test. It does not parse stdout, because the reporter's output format is not a
 * contract and this must not silently stop matching.
 *
 * Usage:
 *   node scripts/assert-no-skips.mjs [path/to/report.json]
 */

import { readFileSync } from "node:fs";

const REPORT = process.argv[2] ?? "test-results/e2e-report.json";

/** Every test node in the report, flattened out of the suite tree. */
function collectTests(suite, path, out) {
  const here = suite.title ? [...path, suite.title] : path;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      out.push({
        name: [...here, spec.title].join(" › "),
        status: test.status,
        expectedStatus: test.expectedStatus,
        results: test.results ?? [],
      });
    }
  }
  for (const child of suite.suites ?? []) collectTests(child, here, out);
  return out;
}

function main() {
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch (error) {
    console.error(
      `assert-no-skips: could not read the Playwright JSON report at ${REPORT}.\n` +
        `Run the suite first. The config always writes this file.\n` +
        `Underlying error: ${error.message}`,
    );
    process.exit(2);
  }

  const tests = collectTests(report, [], []);

  /**
   * A report with no tests is a failure, not a vacuously clean run.
   *
   * This matters more since the browser job is sharded. Each shard is a separate runner
   * with its own report, so a shard whose `--shard` argument is wrong - or that silently
   * collects nothing - would otherwise print "0 test(s) ran, none skipped" and pass. That
   * is the same silent-coverage failure this guard exists to catch, one level up: not a
   * test pretending to pass, but a whole slice of the suite not existing.
   */
  if (tests.length === 0) {
    console.error(
      `assert-no-skips: ${REPORT} contains no tests at all.\n` +
        "An empty report is not a clean run. Under sharding this is how a shard that was\n" +
        "handed the wrong --shard argument would pass while running nothing.",
    );
    process.exit(1);
  }

  /**
   * A skip is any test whose *result status* is `skipped`, which covers both a static
   * `test.skip(...)` and a runtime `test.skip(true, ...)`. Checking the result status
   * rather than the expectation is deliberate: a test that was expected to be skipped
   * still does not validate anything, so it still must not appear in a final run.
   */
  const skipped = tests.filter((test) => test.results.some((r) => r.status === "skipped"));

  const notRun = tests.filter((test) => test.results.length === 0);

  if (notRun.length > 0) {
    console.error(`assert-no-skips: ${notRun.length} test(s) produced no result at all:`);
    for (const test of notRun) console.error(`  · ${test.name}`);
    process.exit(1);
  }

  if (skipped.length > 0) {
    console.error(
      `\nassert-no-skips: ${skipped.length} skipped test(s). A skip cannot be read as a pass,\n` +
        `so this run does not close the gate.\n`,
    );
    for (const test of skipped) {
      const reason = test.results.flatMap((r) => r.error?.message ?? []).join(" ").trim();
      console.error(`  · ${test.name}`);
      if (reason) console.error(`      ${reason.split("\n")[0]}`);
    }
    console.error(
      `\nIf a skip is genuinely unavoidable, the prerequisite belongs in the harness rather\n` +
        `than in a skip - see e2e/fixtures/app-mock.ts and e2e/staff-surfaces.spec.ts.\n`,
    );
    process.exit(1);
  }

  console.log(`assert-no-skips: ${tests.length} test(s) ran, none skipped.`);
}

main();
