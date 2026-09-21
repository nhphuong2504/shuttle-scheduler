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
// Usage:
//   node scripts/verify-build-target.mjs            # the normal build (`.output/`)
//   node scripts/verify-build-target.mjs --sandbox   # the Lovable build (`dist/`)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const sandbox = process.argv.includes("--sandbox");
const outputDir = sandbox ? "dist" : ".output";
const serverDir = join(outputDir, "server");

function readEnvFile(path) {
  const out = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
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

const env = { ...readEnvFile(".env"), ...process.env };
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

const files = [...walk(serverDir)];
if (files.length === 0) {
  console.error(
    `No JavaScript found in ${serverDir}.\n` +
      `Run \`npm run build\`${sandbox ? " with LOVABLE_SANDBOX=1" : ""} first.`,
  );
  process.exit(1);
}

let sawUrl = false;
let sawKey = false;
// Kept for visibility rather than for the decision, and marked so a reader does not mistake a
// library default for the deployment target.
const hosts = new Set();
const HOSTS = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:supabase\.co|lovable\.cloud)/gi;

for (const file of files) {
  const contents = readFileSync(file, "utf8");
  if (contents.includes(expectedUrl)) sawUrl = true;
  if (contents.includes(expectedKey)) sawKey = true;
  for (const host of contents.match(HOSTS) ?? []) hosts.add(host);
}

console.log(`Build output : ${serverDir}`);
console.log(`Built against: ${expectedUrl}`);
console.log(`Modules      : ${files.length}`);
if (hosts.size > 0) {
  console.log(
    `Hosts in the bundle (supabase-js also carries defaults such as realtime.supabase.co):\n` +
      [...hosts].sort().map((host) => `  ${host}`).join("\n"),
  );
}

if (sawUrl && sawKey) {
  console.log("\nOK: the build contains the configured project's URL and publishable key.");
  process.exit(0);
}

console.error(
  `\nThis build does NOT contain ${!sawUrl ? "the configured URL" : "the configured publishable key"}.\n` +
    "The URL and key are baked in at build time and cannot be changed on the deployed Worker,\n" +
    "so deploying this would publish a Worker pointed at the wrong backend.\n" +
    "Fix VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then rebuild.",
);
process.exit(1);
