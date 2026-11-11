import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ROOT, snapshot } from "./core.mjs";
import { envValues, localIntegration } from "./doctor.mjs";

export function npmInvocation(step) {
  let cli = process.env.npm_execpath;
  if (!cli || !existsSync(cli)) {
    try {
      cli = path.join(
        path.dirname(createRequire(import.meta.url).resolve("npm/package.json")),
        "bin/npm-cli.js",
      );
    } catch {
      throw new Error("Run through npm run so the cross-platform npm CLI path is available.");
    }
  }
  return {
    command: process.execPath,
    args: [cli, "run", step.script, ...(step.args?.length ? ["--", ...step.args] : [])],
  };
}

export function redactor(root, environment = process.env, extra = []) {
  const files = ["", "integration"].flatMap((directory) => {
    const base = path.join(root, directory);
    return existsSync(base)
      ? readdirSync(base)
          .filter((name) => /^\.env(?:\..+)?$/.test(name) && name !== ".env.example")
          .map((name) => path.join(directory, name))
      : [];
  });
  // Keep values from every environment, including overridden copies of the same key.
  const entries = [
    ...files.flatMap((file) => Object.entries(envValues(root, file))),
    ...Object.entries(environment),
    ...extra.flatMap((values) => Object.entries(values)),
  ];
  const secrets = entries
    .filter(([key, value]) => value && /key|secret|token|password|credential/i.test(key))
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  return (text) => {
    for (const value of secrets) text = text.split(value).join("[REDACTED]");
    return text
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED JWT]")
      .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED KEY]");
  };
}

// Line buffering keeps credentials split across stream chunks from escaping redaction.
export function lineSink(emit, redact) {
  const decoder = new StringDecoder("utf8");
  let pending = "",
    dropping = false;
  return (chunk, end = false) => {
    pending += end ? decoder.end() : decoder.write(chunk);
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      if (!dropping) emit(redact(pending.slice(0, index)) + "\n");
      pending = pending.slice(index + 1);
      dropping = false;
    }
    if (pending.length > 1_048_576) {
      emit("[oversized log line omitted]\n");
      pending = "";
      dropping = true;
    }
    if (end && pending && !dropping) {
      emit(redact(pending) + "\n");
      pending = "";
    }
  };
}

/**
 * Removes all but the newest `keep` run directories. Old runs are never reused as evidence,
 * so they are only disk use. Run ids start with an ISO timestamp, so name order is age order.
 */
export function pruneRuns(root, keep = 10) {
  const base = path.join(root, "test-results/agent");
  if (!existsSync(base)) return [];
  const stale = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, -keep);
  for (const name of stale) rmSync(path.join(base, name), { recursive: true, force: true });
  return stale;
}

export async function runSteps(
  steps,
  {
    root = ROOT,
    stage = "close",
    summary = true,
    print = console.log,
    identify = snapshot,
    invocation = npmInvocation,
    integrationReady = localIntegration,
    comparisonBase = null,
  } = {},
) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, "test-results/agent", runId);
  mkdirSync(directory, { recursive: true });
  pruneRuns(root);
  const report = {
    runId,
    stage,
    comparisonBase,
    source: identify(root),
    startedAt: new Date().toISOString(),
    status: "running",
    steps: [],
  };
  const manifest = path.join(directory, "manifest.json");
  const save = () => writeFileSync(manifest, JSON.stringify(report, null, 2) + "\n");
  const redact = redactor(
    root,
    process.env,
    steps.map((step) => step.env ?? {}),
  );
  let child = null,
    interrupted = null;
  const onSignal = (signal) => {
    interrupted = signal;
    if (!child?.pid) return;
    try {
      if (process.platform === "win32")
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  const onInt = () => onSignal("SIGINT"),
    onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  save();
  try {
    for (const step of steps) {
      if (interrupted) break;
      const started = Date.now();
      const log = path.join(directory, `${step.name}.log`);
      const result = {
        name: step.name,
        command: ["npm", "run", step.script, ...(step.args ?? [])],
        startedAt: new Date().toISOString(),
        log: path.relative(root, log),
      };
      report.steps.push(result);
      save();
      if (step.name === "integration" && !integrationReady(root)) {
        Object.assign(result, { status: "blocked", exitCode: 1, durationMs: 0 });
        writeFileSync(
          log,
          "Local integration target is not ready. Run agent:doctor --integration; use the existing local-stack/target helpers and restore your original configuration. No hosted fallback is allowed.\n",
        );
        print(`BLOCKED integration — ${result.log}`);
        report.status = "blocked";
        break;
      }
      const sink = createWriteStream(log);
      let tail = [];
      const emit = (line) => {
        sink.write(line);
        tail = [...tail, line.trimEnd()].slice(-60);
        if (!summary) process.stdout.write(line);
      };
      let outcome;
      const vitest = ["test", "test:integration"].includes(step.script);
      const resultFile = path.join(directory, `${step.name}.json`);
      if (vitest) result.resultFile = path.relative(root, resultFile);
      const executedStep = vitest
        ? {
            ...step,
            args: [
              ...(step.args ?? []),
              "--reporter=default",
              "--reporter=json",
              `--outputFile=${resultFile}`,
            ],
          }
        : step;
      try {
        const command = invocation(executedStep);
        result.command = [command.command, ...command.args].map((part) => redact(part));
        if (summary) print(`RUN ${step.name}`);
        outcome = await new Promise((resolve) => {
          child = spawn(command.command, command.args, {
            cwd: root,
            env: { ...process.env, ...step.env },
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
          const stdout = lineSink(emit, redact),
            stderr = lineSink(emit, redact);
          child.stdout.on("data", stdout);
          child.stderr.on("data", stderr);
          child.once("error", (error) => {
            emit(redact(error.message) + "\n");
          });
          child.once("close", (code, signal) => {
            stdout(Buffer.alloc(0), true);
            stderr(Buffer.alloc(0), true);
            child = null;
            resolve({ exitCode: Number.isInteger(code) && code >= 0 ? code : 1, signal });
          });
        });
      } catch (error) {
        emit(redact(error.message) + "\n");
        outcome = { exitCode: 1, signal: null };
      }
      await new Promise((resolve, reject) => {
        sink.once("error", reject);
        sink.end(resolve);
      });
      if (!existsSync(log)) {
        // Preserve a failed manifest even when a child unexpectedly cleans a parent folder.
        mkdirSync(directory, { recursive: true });
        const error = "Step log was removed by another process; verification evidence was lost.";
        writeFileSync(log, error + "\n");
        tail.push(error);
        outcome = { ...outcome, exitCode: 1, error };
      }
      Object.assign(result, outcome, {
        durationMs: Date.now() - started,
        status: outcome.exitCode === 0 && !outcome.signal ? "passed" : "failed",
      });
      let vitestData;
      if (vitest && existsSync(resultFile)) {
        const raw = readFileSync(resultFile, "utf8");
        try {
          const scrub = (value) =>
            typeof value === "string"
              ? redact(value)
              : Array.isArray(value)
                ? value.map(scrub)
                : value && typeof value === "object"
                  ? Object.fromEntries(
                      Object.entries(value).map(([key, item]) => [key, scrub(item)]),
                    )
                  : value;
          vitestData = scrub(JSON.parse(raw));
          writeFileSync(resultFile, JSON.stringify(vitestData, null, 2) + "\n");
        } catch {
          writeFileSync(resultFile, redact(raw));
        }
      }
      if (result.status === "passed" && vitest) {
        try {
          const data = vitestData;
          if (
            !data?.success ||
            !(data.numTotalTests > 0) ||
            data.numPassedTests !== data.numTotalTests ||
            data.numFailedTests !== 0 ||
            data.numPendingTests !== 0 ||
            data.startTime < started - 2_000 ||
            !Number.isFinite(data.startTime)
          )
            throw new Error("Vitest report missing, stale, skipped, empty or unsuccessful");
          result.tests = data.numTotalTests;
          result.resultFile = path.relative(root, resultFile);
        } catch (error) {
          result.status = "failed";
          result.exitCode = 1;
          result.error = redact(error.message);
          tail.push(result.error);
          appendFileSync(log, result.error + "\n");
        }
      }
      if (
        result.status === "passed" &&
        (step.name.includes("browser") || step.script === "test:e2e:final")
      ) {
        // The strict wrapper checks result content; freshness additionally prevents stale evidence.
        try {
          const browser = JSON.parse(
            readFileSync(path.join(root, "test-results/e2e-report.json"), "utf8"),
          );
          if (
            !Number.isFinite(Date.parse(browser.stats?.startTime)) ||
            Date.parse(browser.stats.startTime) < started - 2_000 ||
            browser.stats?.skipped !== 0 ||
            browser.stats?.unexpected !== 0 ||
            !(browser.stats?.expected > 0)
          )
            throw new Error("Browser report missing, stale or unsuccessful");
          result.tests = browser.stats.expected;
        } catch (error) {
          result.status = "failed";
          result.exitCode = 1;
          result.error = redact(error.message);
          tail.push(result.error);
          appendFileSync(log, result.error + "\n");
        }
      }
      print(
        `${result.status.toUpperCase()} ${step.name} ${(result.durationMs / 1000).toFixed(1)}s${result.tests ? ` (${result.tests} tests)` : ""} — ${result.log}`,
      );
      save();
      if (result.status !== "passed") {
        tail.forEach((line) => print(line));
        report.status = "failed";
        break;
      }
    }
    if (interrupted) {
      report.status = "interrupted";
      report.signal = interrupted;
    }
    if (report.status === "running") report.status = steps.length ? "passed" : "no-checks";
    if (identify(root).fingerprint !== report.source.fingerprint) {
      report.status = "source-changed";
      print(
        "Source changed during verification; this run is not final evidence for the new snapshot.",
      );
    }
  } catch (error) {
    report.status = "failed";
    report.error = redact(error.message);
    print(report.error);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    report.finishedAt = new Date().toISOString();
    save();
  }
  print(`${report.status.toUpperCase()} — ${path.relative(root, manifest)}`);
  return {
    report,
    exitCode:
      report.status === "passed"
        ? 0
        : report.signal === "SIGINT"
          ? 130
          : report.signal === "SIGTERM"
            ? 143
            : (report.steps.find((step) => step.exitCode > 0)?.exitCode ?? 1),
  };
}
