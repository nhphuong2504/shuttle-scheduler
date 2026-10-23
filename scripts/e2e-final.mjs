#!/usr/bin/env node
/**
 * The phase-close gate, in one cross-platform command.
 *
 * ## Why this exists
 *
 * `"test:e2e:final": "E2E_REQUIRE_STAFF=1 playwright test && node scripts/assert-no-skips.mjs"`
 * is POSIX shell syntax. npm runs a script through `cmd.exe` on Windows, which reads
 * `E2E_REQUIRE_STAFF=1` as the name of a program to execute and fails before Playwright starts:
 *
 *     'E2E_REQUIRE_STAFF' is not recognized as an internal or external command
 *
 * So the gate that AGENTS.md makes mandatory at every phase close could not be run with its own
 * command on the Windows machine this repository is developed on. Setting the variable in
 * PowerShell and calling Playwright directly worked, but a gate that has to be remembered is a
 * gate that eventually is not run - which is the same failure `assert-no-skips` exists to prevent.
 *
 * ## What it does
 *
 * 1. Runs `playwright test` with `E2E_REQUIRE_STAFF=1`, so a missing prerequisite fails at the
 *    moment of skipping instead of quietly skipping. The env var is set here rather than in the
 *    shell, so it cannot be forgotten and cannot be defeated by the shell's syntax.
 * 2. Only when that passes, runs `assert-no-skips` over the JSON report the config always writes.
 *    A failed run writes a report too, so the order matters: the guard is about a *passing* run
 *    that contained skips.
 *
 * Extra arguments are passed through to Playwright, so
 * `node scripts/e2e-final.mjs e2e/desk.spec.ts` debugs one file with the same rules.
 *
 * Usage:
 *   npm run test:e2e:final
 *   node scripts/e2e-final.mjs [playwright args...]
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The Playwright CLI's own entry point, run with the current Node binary.
 *
 * Not `npx playwright`: on Windows `npx` is a `.cmd` shim, which a child process can only reach
 * through `shell: true`, and Node warns that a shell concatenates rather than escapes its arguments
 * (`DEP0190`). Resolving the file avoids the shell, the shim, and the warning, and behaves the same
 * on every platform.
 */
const PLAYWRIGHT_CLI = require.resolve("@playwright/test/cli");

const run = (command, args, env) => {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const env = { ...process.env, E2E_REQUIRE_STAFF: "1" };

const playwrightStatus = run(process.execPath, [PLAYWRIGHT_CLI, "test", ...process.argv.slice(2)], env);
if (playwrightStatus !== 0) {
  console.error(`\ntest:e2e:final: playwright exited ${playwrightStatus}. Skips were not assessed.`);
  process.exit(playwrightStatus);
}

const guardStatus = run(process.execPath, ["scripts/assert-no-skips.mjs"], env);
if (guardStatus !== 0) {
  console.error("\ntest:e2e:final: the run passed but contained skipped tests.");
  process.exit(guardStatus);
}
