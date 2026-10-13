// Reports which backend a build was compiled against, and fails if it disagrees with the
// environment. Run before deploying.
//
// WHY THIS EXISTS
//
// `vite.config.ts` injects every `VITE_`-prefixed variable as a literal `define`, so the
// Supabase URL and publishable key are baked into both bundles at build time. The Worker reads
// no runtime configuration for them - verified: a build exposes only the `ASSETS` binding, no
// vars - which means a deployed Worker cannot be repointed by changing a Cloudflare variable.
//
// That has a direct consequence for deployment: building with `.env` still aimed at one backend
// and deploying produces a Worker that talks to that backend, with nothing in the output to
// signal it. Since the migration deliberately runs two builds against two different backends
// (staging first, production at cutover), getting this wrong is a matter of a forgotten repoint
// rather than an exotic mistake.
//
// THE CHECK IS AN ASSERTION ON TWO EXPECTED STRINGS, not a heuristic over hosts found in the
// bundle. Grepping for anything host-shaped looks plausible and is wrong in a way worth
// recording: supabase-js carries `realtime.supabase.co` as a default endpoint, so a naive
// "exactly one backend host" rule fails on a perfectly good build. The publishable key has no
// such problem - it is a unique opaque string that appears only if that project is the target.
//
// IN PRODUCTION MODE (the default) the check is stronger than "the bundle matches the
// configured values". The configured project must BE the production project, and the
// generated wrangler.json must name the expected Worker. Both exist because the migration
// left three Supabase projects and two Workers in play: a build that quietly carries the
// Lovable or staging project produces a working Worker writing to the wrong database, and
// the failure is not visible in the output. `--mode development` keeps the weaker check,
// because a staging build is allowed to target staging.
//
// Usage:
//   node scripts/verify-build-target.mjs                # checks a `npm run build` output
//   node scripts/verify-build-target.mjs --mode development   # checks a `build:dev` output

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const outputDir = ".output";
const serverDir = join(outputDir, "server");

/**
 * The project this repository deploys to, and the two a production build must never
 * silently target instead. `hdmfxndanyrbxedgboev` is the Lovable Cloud project the
 * migration moved away from; `dzilzdxzdrrbdimhbiwv` is staging. Both hold real data.
 */
const PRODUCTION_PROJECT_REF = "bwzemvaftzforfmaprif";
const KNOWN_WRONG_REFS = {
  hdmfxndanyrbxedgboev: "the legacy Lovable Cloud project",
  dzilzdxzdrrbdimhbiwv: "the staging project",
};

/**
 * Pinned in `vite.config.ts` so Nitro cannot derive a name from the git remote, which
 * resolved to the name of the pre-existing production Worker.
 */
const EXPECTED_WORKER_NAME = "tournova-ops";

function readEnvFile(path) {
  const out = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  // Split on `\r?\n`, not `\n`. On Windows the file is CRLF, and a line that keeps its
  // trailing `\r` cannot match `(.*)$` below - `.` never matches `\r` - so every value
  // silently reads as absent and the guard reports "set VITE_SUPABASE_URL" instead of
  // checking anything. A BOM would break the first assignment the same way.
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    const rawValue = match[2];
    if (name === undefined || rawValue === undefined) continue;
    out[name] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Every `.mjs`/`.js` file under a directory, so SSR chunks are covered as well as the entry. */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(mjs|js)$/.test(entry)) yield path;
  }
}

/**
 * Resolve environment files the way Vite does: `.env` first, then `.env.<mode>` overriding it,
 * with the real environment overriding both.
 *
 * This precedence is the whole reason the check still means anything after `env-split`:
 * `npm run dev` runs mode=development and sees `.env` (staging), while `npm run build` runs
 * mode=production and sees `.env.production`. A guard that only read `.env` would compare a
 * production bundle against staging values, report a mismatch, and be wrong - or worse, be
 * "fixed" by someone pointing `.env` back at production.
 */
function mode() {
  const index = process.argv.indexOf("--mode");
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? "production";
}

const activeMode = mode();
const productionMode = activeMode === "production";

const env = {
  ...readEnvFile(".env"),
  ...readEnvFile(`.env.${activeMode}`),
  ...process.env,
};
const expectedUrl = env["VITE_SUPABASE_URL"] || env["SUPABASE_URL"];
const expectedKey = env["VITE_SUPABASE_PUBLISHABLE_KEY"] || env["SUPABASE_PUBLISHABLE_KEY"];

if (!expectedUrl || !expectedKey) {
  console.error(
    "Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY before checking a build.\n" +
      "Without them there is nothing to compare the build against, and this check is the only\n" +
      "thing standing between a stale .env and a Worker pointed at the wrong backend.",
  );
  process.exit(2);
}

/** `https://abcdefghijklmnop.supabase.co` -> `abcdefghijklmnop`. */
function projectRef(url) {
  try {
    return new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

if (productionMode) {
  const configuredRef = projectRef(expectedUrl);
  const wrongBecause = KNOWN_WRONG_REFS[configuredRef];
  if (wrongBecause) {
    console.error(
      `Refusing a production check configured against ${wrongBecause} (${configuredRef}).\n` +
        `A production build must target ${PRODUCTION_PROJECT_REF}. Fix .env.production, then rebuild.`,
    );
    process.exit(1);
  }
  if (configuredRef !== PRODUCTION_PROJECT_REF) {
    console.error(
      `Refusing a production check: the configured project is ` +
        `"${configuredRef || "(unreadable)"}", not ${PRODUCTION_PROJECT_REF}.\n` +
        "A production build bakes this in, so deploying it would publish a Worker pointed at\n" +
        "another database with nothing in the output to signal it.",
    );
    process.exit(1);
  }
}

const files = [...walk(serverDir)];
if (files.length === 0) {
  console.error(`No JavaScript found in ${serverDir}.\nRun \`npm run build\` first.`);
  process.exit(1);
}

// Nitro writes the Worker name into the generated wrangler.json, so this reads what a
// `wrangler deploy` would actually target rather than what the config intends.
let workerConfig = {};
try {
  workerConfig = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8"));
} catch {
  workerConfig = {};
}
const workerName = workerConfig.name ?? "";

/**
 * The production address, asserted for the same reason the name above is.
 *
 * `routes` is the kind of setting whose absence is silent: a Worker with no route still
 * deploys, still answers on its `*.workers.dev` address, and looks entirely healthy - it has
 * simply stopped being served on the domain people use. That already happened once in this
 * repository's deployment, in the other direction: adding a `routes` entry makes Wrangler
 * disable `workers_dev` by default, which left the app unreachable on the address it shipped
 * on. Both halves are therefore asserted, because each is invisible until somebody visits.
 *
 * The custom-domain entry is matched structurally rather than by string, so a route added
 * alongside it (a second hostname, say) does not fail this check while the canonical one is
 * still present.
 */
const customDomains = (workerConfig.routes ?? [])
  .filter((route) => route && route.custom_domain === true)
  .map((route) => route.pattern);
const EXPECTED_DOMAIN = "tournova.app";

if (productionMode && !customDomains.includes(EXPECTED_DOMAIN)) {
  console.error(
    `\nThis build would deploy ${workerName || "(unnamed)"} without the address ` +
      `${EXPECTED_DOMAIN}.\n` +
      `Custom domains in the generated config: ${customDomains.join(", ") || "(none)"}.\n` +
      "The route is stated in vite.config.ts; a build that has lost it would deploy a Worker\n" +
      "that is reachable only on its workers.dev address, with nothing in the output to say so.",
  );
  process.exit(1);
}

if (productionMode && workerConfig.workers_dev !== true) {
  console.error(
    `\nThis build would deploy ${workerName || "(unnamed)"} with its workers.dev address ` +
      "disabled.\n" +
      "Wrangler disables it by default as soon as any route is declared, which would retire\n" +
      "the URL the app shipped on - and the one Supabase's redirect allow-list names. It is\n" +
      "opted back in explicitly in vite.config.ts.",
  );
  process.exit(1);
}

if (workerName !== EXPECTED_WORKER_NAME) {
  const detail =
    `The generated Worker is named "${workerName || "(none)"}", not "${EXPECTED_WORKER_NAME}".\n` +
    "The name is pinned in vite.config.ts because Nitro's default is derived from the git\n" +
    "remote and resolved to the pre-existing production Worker, which a bare deploy would\n" +
    "have published over.";
  if (productionMode) {
    console.error(`\n${detail}`);
    process.exit(1);
  }
  console.warn(`\nWarning: ${detail}`);
}

let sawUrl = false;
let sawKey = false;
// Kept for visibility rather than for the decision, and marked so a reader does not mistake a
// library default for the deployment target.
const hosts = new Set();
const HOSTS = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.supabase\.co/gi;

for (const file of files) {
  const contents = readFileSync(file, "utf8");
  if (contents.includes(expectedUrl)) sawUrl = true;
  if (contents.includes(expectedKey)) sawKey = true;
  for (const host of contents.match(HOSTS) ?? []) hosts.add(host);
}

console.log(`Build output : ${serverDir}`);
console.log(`Mode         : ${activeMode}${productionMode ? " (production assertions on)" : ""}`);
console.log(`Built against: ${expectedUrl}`);
console.log(`Worker       : ${workerName || "(not found)"}`);
console.log(`Custom domain: ${customDomains.join(", ") || "(none)"}`);
console.log(`workers.dev  : ${workerConfig.workers_dev === true ? "enabled" : "disabled"}`);
console.log(`Modules      : ${files.length}`);
if (hosts.size > 0) {
  console.log(
    `Hosts in the bundle (supabase-js also carries defaults such as realtime.supabase.co):\n` +
      [...hosts].sort().map((host) => `  ${host}`).join("\n"),
  );
}

if (sawUrl && sawKey) {
  console.log(
    productionMode
      ? `\nOK: production check passed. The build carries ${PRODUCTION_PROJECT_REF}'s URL and\n` +
          `publishable key, and the generated Worker is ${EXPECTED_WORKER_NAME}.`
      : "\nOK: the build contains the configured project's URL and publishable key.",
  );
  process.exit(0);
}

console.error(
  `\nThis build does NOT contain ${!sawUrl ? "the configured URL" : "the configured publishable key"}.\n` +
    "The URL and key are baked in at build time and cannot be changed on the deployed Worker,\n" +
    "so deploying this would publish a Worker pointed at the wrong backend.\n" +
    "Fix VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then rebuild.",
);
process.exit(1);
