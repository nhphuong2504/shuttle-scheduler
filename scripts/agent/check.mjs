import {
  ROOT,
  changedFiles,
  checkPlan,
  parseArgs,
  verificationBase,
  npmStep,
  unique,
} from "./core.mjs";
import { runSteps } from "./runner.mjs";

try {
  const { options, paths } = parseArgs(
    process.argv.slice(2),
    ["changed", "stage", "base", "run", "json", "ui-only"],
    ["changed", "run", "json", "ui-only"],
  );
  if ((!options.changed && !paths.length) || (options.changed && paths.length))
    throw new Error("Provide --changed or explicit paths");
  const closing = options.stage === "close";
  const base = options.base ?? (closing ? verificationBase() : "HEAD");
  const files = options.changed
    ? changedFiles(ROOT, base ?? "HEAD")
    : closing
      ? unique([...paths, ...changedFiles(ROOT, base ?? "HEAD")])
      : paths;
  const plan = checkPlan(files, {
    stage: options.stage ?? "iterate",
    uiOnly: !!options["ui-only"],
  });
  if (closing && !base && !plan.integration) {
    plan.steps.push(npmStep("integration", "test:integration", [], { TZ: "America/Chicago" }));
    plan.integration = true;
  }
  if (!options.json) {
    console.log(
      `Stage: ${plan.stage}${plan.stage === "iterate" ? " (iteration only; not phase-close evidence)" : ""} | ${plan.status}`,
    );
    if (options["ui-only"])
      console.log("Declared UI-only: use only after reviewing that behavior is unchanged.");
    plan.steps.forEach((step) =>
      console.log(
        `  npm run ${step.script}${step.args.length ? ` -- ${step.args.join(" ")}` : ""}`,
      ),
    );
    if (plan.integration)
      console.log("Required: local integration; missing prerequisites return non-success.");
    if (!options.run)
      console.log("Plan only. Add --run to execute; use agent:verify for phase close.");
  }
  if (options.run && plan.steps.length) {
    const result = await runSteps(plan.steps, {
      stage: plan.stage,
      comparisonBase: base,
      ...(options.json ? { print: () => {} } : {}),
    });
    if (options.json) console.log(JSON.stringify({ plan, report: result.report }, null, 2));
    process.exitCode = result.exitCode;
  } else if (options.json) console.log(JSON.stringify(plan, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
