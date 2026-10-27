import { changedFiles, checkPlan, parseArgs, verificationBase } from "./core.mjs";
import { runSteps } from "./runner.mjs";

try {
  const { options, paths } = parseArgs(
    process.argv.slice(2),
    ["summary", "integration", "base"],
    ["summary", "integration"],
  );
  if (paths.length)
    throw new Error("verify accepts options only; use agent:check for focused paths");
  const base = verificationBase(undefined, options.base);
  const plan = checkPlan(changedFiles(undefined, base ?? "HEAD"), { stage: "close" });
  if ((options.integration || !base) && !plan.integration)
    plan.steps.push({
      name: "integration",
      script: "test:integration",
      args: [],
      env: { TZ: "America/Chicago" },
    });
  console.log(
    `Verification scope: ${base ?? "unresolved baseline; integration required conservatively"}`,
  );
  process.exitCode = (
    await runSteps(plan.steps, { summary: !!options.summary, comparisonBase: base })
  ).exitCode;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
