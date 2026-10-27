import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const unique = (values) => [...new Set(values)];
export const git = (root, args, encoding = "utf8") =>
  execFileSync("git", args, { cwd: root, encoding, stdio: ["ignore", "pipe", "pipe"] });

export function relativePath(root, input) {
  const relative = path.relative(root, path.resolve(root, input)).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../")) {
    throw new Error("Pass a path inside the repository, not the repository root.");
  }
  return relative;
}

export function matches(pattern, file) {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      expression += ".*";
      i++;
    } else if (c === "*") expression += "[^/]*";
    else expression += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(file);
}

export function loadMap(root = ROOT) {
  const map = JSON.parse(readFileSync(path.join(root, "scripts/agent/areas.json"), "utf8"));
  const ids = new Set();
  if (map.version !== 1 || !Array.isArray(map.areas) || !map.areas.length)
    throw new Error("Invalid area map");
  for (const area of map.areas) {
    if (
      !area.id ||
      ids.has(area.id) ||
      !["high", "standard"].includes(area.risk) ||
      typeof area.integration !== "boolean" ||
      !["patterns", "documents", "entries", "tests", "browserTests"].every(
        (key) => Array.isArray(area[key]) && area[key].every((value) => typeof value === "string"),
      )
    )
      throw new Error("Invalid or duplicate area definition");
    ids.add(area.id);
  }
  return map;
}

export function contextFor(inputs, { root = ROOT, map = loadMap(root) } = {}) {
  const files = unique(inputs.map((input) => relativePath(root, input)));
  if (!files.length) throw new Error("Provide at least one path.");
  const areas = map.areas.filter((area) =>
    files.some((file) => area.patterns.some((p) => matches(p, file))),
  );
  const unknown = files.filter(
    (file) => !areas.some((area) => area.patterns.some((p) => matches(p, file))),
  );
  const instructions = ["AGENTS.md"];
  for (const file of files) {
    const parts = file.split("/");
    // New/deleted files still inherit the instructions in their ancestor directories.
    for (let i = 1; i < parts.length; i++) {
      const candidate = `${parts.slice(0, i).join("/")}/AGENTS.md`;
      if (existsSync(path.join(root, candidate))) instructions.push(candidate);
    }
    const own = `${file}/AGENTS.md`;
    if (existsSync(path.join(root, own))) instructions.push(own);
  }
  return {
    files,
    areas: areas.map((area) => area.id),
    unknown,
    risk: unknown.length || areas.some((area) => area.risk === "high") ? "high" : "standard",
    integration: unknown.length > 0 || areas.some((area) => area.integration),
    instructions: unique(instructions),
    documents: unique(areas.flatMap((area) => area.documents)),
    entries: unique(areas.flatMap((area) => area.entries)),
    tests: unique(areas.flatMap((area) => area.tests)),
    browserTests: unique(areas.flatMap((area) => area.browserTests)),
  };
}

export function changedFiles(root = ROOT, base = "HEAD") {
  // --end-of-options prevents a supplied ref from becoming a Git option.
  const commit = git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${base}^{commit}`,
  ]).trim();
  return unique(
    [
      ...git(root, ["diff", "--name-only", "--no-renames", "-z", commit, "--"]).split("\0"),
      ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ].filter(Boolean),
  );
}

export function verificationBase(root = ROOT, explicit) {
  if (explicit)
    return git(root, ["rev-parse", "--verify", "--end-of-options", `${explicit}^{commit}`]).trim();
  for (const ref of ["refs/remotes/origin/main", "refs/heads/main"]) {
    try {
      return git(root, ["merge-base", "HEAD", ref]).trim();
    } catch {
      /* Try the next local reference, without fetching. */
    }
  }
  return null;
}

export function snapshot(root = ROOT) {
  const revision = git(root, ["rev-parse", "HEAD"]).trim();
  const files = changedFiles(root).filter((file) => !file.startsWith("test-results/"));
  const hash = createHash("sha256").update(revision);
  hash.update(git(root, ["diff", "--binary", "HEAD", "--"], null));
  for (const file of files.sort()) {
    hash.update(file);
    if (existsSync(path.join(root, file))) hash.update(readFileSync(path.join(root, file)));
  }
  return { revision, dirty: files.length > 0, fingerprint: hash.digest("hex") };
}

export function npmStep(name, script, args = [], env = {}) {
  return { name, script, args, env };
}

export const fullSteps = () => [
  npmStep("typecheck", "typecheck"),
  npmStep("agent-contracts", "test:agent"),
  npmStep("unit", "test"),
  npmStep("browser", "test:e2e:final"),
  npmStep("build", "build"),
];

export function checkPlan(
  files,
  { stage = "iterate", uiOnly = false, root = ROOT, map = loadMap(root) } = {},
) {
  if (!["iterate", "checkpoint", "close"].includes(stage))
    throw new Error("stage must be iterate, checkpoint or close");
  if (!files.length && stage !== "close") {
    return { stage, status: "no-changes", integration: false, steps: [] };
  }
  const context = files.length ? contextFor(files, { root, map }) : null;
  if (
    uiOnly &&
    (stage !== "iterate" ||
      !context ||
      context.unknown.length ||
      context.areas.some((area) => !["ui", "documentation"].includes(area)))
  ) {
    throw new Error(
      "--ui-only is an explicit no-behavior-change declaration for UI iteration only; it cannot override other risk areas",
    );
  }
  let steps;
  if (uiOnly) steps = [npmStep("typecheck", "typecheck")];
  else if (stage === "close" || context.risk === "high") steps = fullSteps();
  else if (files.every((file) => file.endsWith(".md")))
    steps = [npmStep("agent-contracts", "test:agent")];
  else {
    steps = [npmStep("typecheck", "typecheck")];
    if (context.tests.length) steps.push(npmStep("focused-unit", "test", context.tests));
    else if (stage === "checkpoint") steps.push(npmStep("unit", "test"));
    if (stage === "checkpoint" && context.browserTests.length) {
      steps.push(npmStep("focused-browser", "test:e2e:final", context.browserTests));
    }
  }
  // Backend verification is additional, never replaced by a mocked browser suite.
  if (context?.integration)
    steps.push(npmStep("integration", "test:integration", [], { TZ: "America/Chicago" }));
  return {
    stage,
    status: "planned",
    classification: uiOnly ? "ui-only-declared-no-behavior-change" : "conservative",
    context,
    integration: context?.integration ?? false,
    steps,
  };
}

export function parseArgs(args, allowed, boolean = []) {
  const options = {},
    paths = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      paths.push(arg);
      continue;
    }
    const [name, ...rest] = arg.slice(2).split("=");
    if (!allowed.includes(name)) throw new Error(`Unknown option: --${name}`);
    if (boolean.includes(name)) {
      if (rest.length) throw new Error(`--${name} takes no value`);
      options[name] = true;
    } else {
      const value = rest.length ? rest.join("=") : args[++i];
      if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
      options[name] = value;
    }
  }
  return { options, paths };
}
