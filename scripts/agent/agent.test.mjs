import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROOT,
  matches,
  loadMap,
  contextFor,
  changedFiles,
  verificationBase,
  snapshot,
  checkPlan,
  fullSteps,
  parseArgs,
} from "./core.mjs";
import { section, localLinks, validateReferences } from "./documents.mjs";
import { diagnose, localIntegration } from "./doctor.mjs";
import { runSteps, redactor, lineSink, npmInvocation } from "./runner.mjs";

function fixture(t, git = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tournova-agent-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, ".nvmrc"), "22\n");
  writeFileSync(path.join(root, "package.json"), "{}\n");
  writeFileSync(path.join(root, ".gitignore"), "test-results/\n.env\n");
  if (git) {
    const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    run("init");
    run("add", ".");
    run(
      "-c",
      "user.name=Agent test",
      "-c",
      "user.email=agent@example.test",
      "commit",
      "-m",
      "Initial fixture",
    );
  }
  return root;
}
const identity = () => ({ revision: "fixture", dirty: false, fingerprint: "same" });
const node = (source) => ({ command: process.execPath, args: ["-e", source] });
const step = (name) => ({ name, script: "fixture", args: [] });
const silent = { print: () => {}, identify: identity };

test("mixed scopes retain high risk/integration, deduplicate, and include ancestor instructions", () => {
  const context = contextFor([
    "src/lib/tournament/registration/participant.ts",
    "src/lib/tournament/new file.ts",
  ]);
  assert.equal(context.risk, "high");
  assert.equal(context.integration, true);
  assert.ok(context.instructions.includes("src/lib/tournament/AGENTS.md"));
  assert.equal(new Set(context.documents).size, context.documents.length);
  assert.equal(contextFor(["some-new-area/strange file.ts"]).integration, true);
  assert.equal(contextFor(["src/lib/scheduling/not-created.ts"]).risk, "high");
  assert.throws(() => contextFor(["../../outside"]), /inside/);
  assert.equal(matches("src/**", "src/lib/a.ts"), true);
  assert.equal(matches("src/*.ts", "src/lib/a.ts"), false);
});

test("all map entries and current document links/anchors are reachable", () => {
  const map = loadMap();
  const refs = [
    "AGENTS.md",
    ...map.areas.flatMap((area) => [
      ...area.documents,
      ...area.entries,
      ...area.tests,
      ...area.browserTests,
    ]),
  ];
  const docs = [
    ...new Set([
      "AGENTS.md",
      "README.md",
      "docs/verification.md",
      "docs/agent-workflow.md",
      "docs/authorization.md",
      "docs/scheduling-decisions.md",
      "supabase/migrations/README.md",
      "docs/reference/authorization.md",
      "docs/reference/scheduling-decisions.md",
      "supabase/migrations/history.md",
      ...map.areas.flatMap((area) => area.documents.map((ref) => ref.split("#")[0])),
    ]),
  ];
  for (const doc of docs) refs.push(...localLinks(ROOT, doc));
  assert.deepEqual(validateReferences(ROOT, refs), []);
  const words = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8").trim().split(/\s+/).length;
  assert.ok(words >= 500 && words <= 700, `root guidance has ${words} words`);
});

test("section reads stop at the next peer heading and ignore code headings", () => {
  const text = "# Doc\n## One\na\n### Detail\nb\n```md\n## fake\n```\n## Two\nc\n";
  assert.ok(section(text, "one").includes("### Detail"));
  assert.ok(!section(text, "one").includes("## Two"));
  assert.throws(() => section(text, "absent"), /Unknown/);
});

test("changed paths include staged, unstaged, deleted and untracked names without shell interpretation", (t) => {
  const root = fixture(t, true);
  writeFileSync(path.join(root, "staged.txt"), "one");
  execFileSync("git", ["add", "--", "staged.txt"], { cwd: root });
  writeFileSync(path.join(root, "staged.txt"), "two");
  rmSync(path.join(root, ".nvmrc"));
  writeFileSync(path.join(root, "name with spaces;no-shell.ts"), "x");
  writeFileSync(path.join(root, ".env"), "PRIVATE_KEY=ignored\n");
  const files = changedFiles(root);
  assert.ok(files.includes("staged.txt"));
  assert.ok(files.includes(".nvmrc"));
  assert.ok(files.includes("name with spaces;no-shell.ts"));
  assert.ok(!files.includes(".env"));
  assert.throws(() => changedFiles(root, "--help"));
  assert.throws(() => changedFiles(root, "missing-ref"));
  const before = snapshot(root).fingerprint;
  writeFileSync(path.join(root, "staged.txt"), "three");
  assert.notEqual(snapshot(root).fingerprint, before);
});

test("high-risk paths always retain the complete gate; clean close still runs it", () => {
  const required = ["typecheck", "agent-contracts", "unit", "browser", "build"];
  assert.deepEqual(
    fullSteps().map((s) => s.name),
    required,
  );
  for (const stage of ["iterate", "checkpoint", "close"]) {
    const plan = checkPlan(["src/lib/tournament/registration/participant.ts"], { stage });
    assert.deepEqual(
      plan.steps.map((s) => s.name),
      [...required, "integration"],
    );
  }
  assert.equal(checkPlan([]).status, "no-changes");
  assert.deepEqual(
    checkPlan([], { stage: "close" }).steps.map((s) => s.name),
    required,
  );
  assert.equal(checkPlan(["docs/new.md"]).steps.length, 1);
  assert.ok(checkPlan(["unknown.tsx"]).steps.some((s) => s.name === "integration"));
  assert.ok(
    checkPlan(["src/components/capacity-estimate.tsx"]).steps.some((s) => s.name === "browser"),
  );
  assert.deepEqual(
    checkPlan(["src/components/capacity-estimate.tsx"], { uiOnly: true }).steps.map((s) => s.name),
    ["typecheck"],
  );
  assert.throws(
    () => checkPlan(["src/lib/tournament/actions.ts"], { uiOnly: true }),
    /cannot override/,
  );
  assert.throws(
    () => checkPlan(["src/components/capacity-estimate.tsx"], { uiOnly: true, stage: "close" }),
    /cannot override/,
  );
  assert.throws(() => checkPlan([], { stage: "typo" }));
  assert.throws(() => parseArgs(["--unknown"], []));
  assert.throws(() => parseArgs(["--base"], ["base"]));
});

test("doctor is read-only and never reports missing dependencies/configuration as ready", async (t) => {
  const root = fixture(t);
  const secret = "private-value-that-must-not-appear";
  writeFileSync(path.join(root, ".env"), `VITE_SUPABASE_PUBLISHABLE_KEY=${secret}\n`);
  const before = readFileSync(path.join(root, ".env"), "utf8");
  const result = await diagnose({ root, probe: async () => "occupied" });
  assert.equal(result.status, "missing-prerequisites");
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(readFileSync(path.join(root, ".env"), "utf8"), before);
  assert.ok(!existsSync(path.join(root, "node_modules")));
  assert.equal(localIntegration(root), false);
});

test("chunk-split secrets and token shapes are redacted before emitting logs", (t) => {
  const root = fixture(t),
    outputs = [];
  const secret = "credential-with-long-value";
  const sink = lineSink((line) => outputs.push(line), redactor(root, { PRIVATE_TOKEN: secret }));
  sink(Buffer.from("prefix credential-with-"));
  sink(Buffer.from("long-value suffix\n"));
  sink(Buffer.alloc(0), true);
  assert.equal(outputs.join(""), "prefix [REDACTED] suffix\n");
});

test("runner is sequential, fails fast, preserves child exit code and redacts persisted logs", async (t) => {
  const root = fixture(t),
    calls = [],
    lines = [];
  writeFileSync(path.join(root, ".env"), "PRIVATE_KEY=credential-fixture-value\n");
  const result = await runSteps([step("first"), step("never")], {
    root,
    ...silent,
    print: (s) => lines.push(s),
    invocation: (s) => {
      calls.push(s.name);
      return node("console.error('credential-fixture-value');process.exit(7)");
    },
  });
  assert.equal(result.exitCode, 7);
  assert.deepEqual(calls, ["first"]);
  assert.equal(result.report.status, "failed");
  const log = readFileSync(path.join(root, result.report.steps[0].log), "utf8");
  assert.ok(log.includes("[REDACTED]"));
  assert.ok(!log.includes("credential-fixture-value"));
  assert.ok(!JSON.stringify(lines).includes("credential-fixture-value"));
});

test("verbose and summary modes execute the same ordered steps", async (t) => {
  const root = fixture(t),
    traces = [];
  for (const summary of [false, true]) {
    const trace = [];
    const result = await runSteps([step("one"), step("two")], {
      root,
      ...silent,
      summary,
      invocation: (s) => {
        trace.push(s.name);
        return node("");
      },
    });
    assert.equal(result.exitCode, 0);
    traces.push(trace);
  }
  assert.deepEqual(traces[0], traces[1]);
});

test("missing, malformed, empty, stale or skipped browser evidence cannot pass", async (t) => {
  const root = fixture(t);
  for (const stats of [
    null,
    "malformed",
    {},
    { startTime: "2000-01-01", expected: 1, skipped: 0, unexpected: 0 },
    { startTime: new Date().toISOString(), expected: 1, skipped: 1, unexpected: 0 },
  ]) {
    const file = path.join(root, "test-results/e2e-report.json");
    mkdirSync(path.dirname(file), { recursive: true });
    if (stats === null) rmSync(file, { force: true });
    else writeFileSync(file, stats === "malformed" ? "bad" : JSON.stringify({ stats }));
    const result = await runSteps([step("browser")], {
      root,
      ...silent,
      invocation: () => node(""),
    });
    assert.notEqual(result.exitCode, 0);
  }
});

test("required integration refuses unsafe/missing target without changing environment or spawning", async (t) => {
  const root = fixture(t);
  let spawned = false;
  const result = await runSteps([step("integration")], {
    root,
    ...silent,
    invocation: () => {
      spawned = true;
      return node("");
    },
  });
  assert.equal(result.report.status, "blocked");
  assert.notEqual(result.exitCode, 0);
  assert.equal(spawned, false);
  assert.ok(!existsSync(path.join(root, "integration/.env")));
});

test("source changes during a successful child invalidate final evidence", async (t) => {
  const root = fixture(t);
  let count = 0;
  const result = await runSteps([step("one")], {
    root,
    print: () => {},
    identify: () => ({ fingerprint: String(count++) }),
    invocation: () => node(""),
  });
  assert.equal(result.report.status, "source-changed");
  assert.notEqual(result.exitCode, 0);
});

test("a catchable interruption records non-success and stops the running child", async (t) => {
  const root = fixture(t),
    driver = path.join(root, "driver.mjs");
  const runner = new URL("./runner.mjs", import.meta.url).href;
  writeFileSync(
    driver,
    `import {runSteps} from ${JSON.stringify(runner)};\nconst result=await runSteps([{name:'waiting',script:'fixture',args:[]}],{root:${JSON.stringify(root)},identify:()=>({fingerprint:'same'}),invocation:()=>({command:process.execPath,args:['-e',\"console.log('child-ready');setInterval(()=>{},1000)\"]}),summary:false});process.exitCode=result.exitCode;`,
  );
  const child = spawn(process.execPath, [driver], { stdio: ["ignore", "pipe", "pipe"] });
  let text = "",
    sent = false;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stdout.on("data", (chunk) => {
    text += chunk;
    if (!sent && text.includes("child-ready")) {
      sent = true;
      child.kill("SIGTERM");
    }
  });
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timeout);
  assert.equal(code, 143);
  assert.ok(text.includes("INTERRUPTED"));
});

test("redaction covers overridden keys, environment variants and explicit child values", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, ".env"), "PRIVATE_KEY=staging-credential-value\n");
  writeFileSync(path.join(root, ".env.production"), "PRIVATE_KEY=production-credential-value\n");
  writeFileSync(path.join(root, ".env.local"), "PRIVATE_KEY=local-credential-value\n");
  const redact = redactor(root, { PRIVATE_KEY: "ambient-credential-value" }, [
    { PRIVATE_KEY: "child-credential-value" },
  ]);
  const output = redact(
    "staging-credential-value production-credential-value local-credential-value ambient-credential-value child-credential-value",
  );
  assert.equal(output, Array(5).fill("[REDACTED]").join(" "));
});

test("a missing executable is failure rather than an unhandled process error", async (t) => {
  const root = fixture(t);
  const result = await runSteps([step("missing")], {
    root,
    ...silent,
    invocation: () => ({ command: path.join(root, "absent-executable"), args: [] }),
  });
  assert.equal(result.report.status, "failed");
  assert.equal(result.exitCode, 1);
});

test("unit reports must be fresh, non-empty and fully passed; child success alone is insufficient", async (t) => {
  const root = fixture(t);
  for (const mode of ["passed", "missing", "skipped", "stale", "empty"]) {
    const result = await runSteps([{ name: "unit", script: "test", args: [] }], {
      root,
      ...silent,
      invocation: (step) => {
        const file = step.args
          .find((arg) => arg.startsWith("--outputFile="))
          .slice("--outputFile=".length);
        const report = {
          success: true,
          numTotalTests: mode === "empty" ? 0 : 1,
          numPassedTests: mode === "skipped" ? 0 : 1,
          numFailedTests: 0,
          numPendingTests: mode === "skipped" ? 1 : 0,
          startTime: mode === "stale" ? 1 : Date.now(),
        };
        return node(
          mode === "missing"
            ? ""
            : `require('node:fs').writeFileSync(${JSON.stringify(file)},${JSON.stringify(JSON.stringify(report))})`,
        );
      },
    });
    assert.equal(result.exitCode === 0, mode === "passed");
  }
});

test("failed native JSON reports are redacted too, without losing failure counts", async (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, ".env"), "PRIVATE_TOKEN=report-credential-value\n");
  const result = await runSteps([{ name: "unit", script: "test", args: [] }], {
    root,
    ...silent,
    invocation: (step) => {
      const file = step.args
        .find((arg) => arg.startsWith("--outputFile="))
        .slice("--outputFile=".length);
      return node(
        `require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify({numFailedTests:1,message:'report-credential-value'}));process.exit(1)`,
      );
    },
  });
  assert.equal(result.exitCode, 1);
  const file = path.join(root, result.report.steps[0].resultFile);
  const report = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(report.numFailedTests, 1);
  assert.equal(report.message, "[REDACTED]");
});

test("npm invocation preserves spaced/metacharacter arguments through a Node CLI, without a shell", (t) => {
  const root = fixture(t),
    directory = path.join(root, "npm with spaces");
  mkdirSync(directory);
  const cli = path.join(directory, "npm-cli.cjs");
  writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)))");
  const original = process.env.npm_execpath;
  try {
    process.env.npm_execpath = cli;
    const command = npmInvocation({
      script: "fixture",
      args: ["name with spaces; echo not-a-command"],
    });
    assert.equal(command.command, process.execPath);
    const output = execFileSync(command.command, command.args, { encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), [
      "run",
      "fixture",
      "--",
      "name with spaces; echo not-a-command",
    ]);
  } finally {
    if (original === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = original;
  }
});

test("phase-close scope includes committed branch changes even when the working tree is clean", (t) => {
  const root = fixture(t, true);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (git("branch", "--show-current").trim() !== "main") git("branch", "main");
  git("checkout", "-b", "feature");
  mkdirSync(path.join(root, "supabase/migrations"), { recursive: true });
  writeFileSync(path.join(root, "supabase/migrations/new.sql"), "-- fixture only");
  git("add", ".");
  git(
    "-c",
    "user.name=Agent test",
    "-c",
    "user.email=agent@example.test",
    "commit",
    "-m",
    "Change fixture",
  );
  assert.deepEqual(changedFiles(root), []);
  const base = verificationBase(root);
  assert.ok(base);
  const files = changedFiles(root, base);
  assert.ok(files.includes("supabase/migrations/new.sql"));
  assert.equal(checkPlan(files, { root, map: loadMap(ROOT), stage: "close" }).integration, true);
  assert.throws(() => verificationBase(root, "missing-ref"));
});

test("child cleanup of an artifact parent cannot silently discard verification evidence", async (t) => {
  const root = fixture(t);
  const result = await runSteps([step("cleaned")], {
    root,
    ...silent,
    invocation: () =>
      node(
        `require('node:fs').rmSync(${JSON.stringify(path.join(root, "test-results/agent"))},{recursive:true,force:true})`,
      ),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.match(
    readFileSync(path.join(root, result.report.steps[0].log), "utf8"),
    /evidence was lost/,
  );
});
