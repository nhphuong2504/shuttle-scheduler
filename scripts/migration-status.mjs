#!/usr/bin/env node
/**
 * Does this project have exactly the migrations the repository does?
 *
 * ## Why this replaces `scripts/migration-drift-check.sql`
 *
 * That SQL file compares `supabase_migrations.schema_migrations` against an `expected` list
 * hardcoded in the file, and its own header says it is a one-time tool for the move between two
 * projects. The list stopped at `20260921000000`, so running it today reports 24 false
 * `DRIFT | applied but no local file` rows for migrations that are present in
 * `supabase/migrations/` - a reader cannot tell a real drift from a stale list. A database-side
 * query cannot see the filesystem, so the list can only ever be hand-maintained, and it will go
 * stale again.
 *
 * This reads the directory instead. The comparison is the same idea, with the side that changes
 * kept as the source of truth.
 *
 * ## What it reports
 *
 *   applied, no local file   a change that exists only in this database; replaying the repository
 *                            onto a new project would silently lose it. This is the drift the
 *                            original tool was written to surface.
 *   local, never applied     a pending migration. `apply-migrations.mjs` would apply it.
 *   OK                       applied=N local=N matched=N, printed even when they agree, because
 *                            zero rows is indistinguishable from a query that did not run.
 *
 * Read-only. Usage:
 *   node scripts/migration-status.mjs <project-ref>
 *   npm run db:drift -- <project-ref>          (the project ref is the first argument)
 *
 * Reads SUPABASE_ACCESS_TOKEN from the environment, falling back to the repository `.env` - the
 * same rule `apply-migrations.mjs` follows, so the two cannot disagree about which token to use.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const ref = args.find((a) => !a.startsWith("--"));

if (!ref) {
  console.error("Usage: node scripts/migration-status.mjs <project-ref>");
  process.exit(2);
}

function readToken() {
  const fromEnv = process.env["SUPABASE_ACCESS_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = readFileSync(join(process.cwd(), ".env"), "utf8");
    const match = text.match(/^\s*SUPABASE_ACCESS_TOKEN\s*=\s*"?([^"\n]+)"?\s*$/m);
    if (match?.[1]) return match[1].trim();
  } catch {
    // Fall through to the error below.
  }
  console.error("No access token. Set SUPABASE_ACCESS_TOKEN, or put it in the repository .env.");
  process.exit(2);
}

const token = readToken();

async function runQuery(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).message ?? text;
    } catch {
      // Keep the raw body.
    }
    throw new Error(detail.trim());
  }
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

const migrationsDir = join(process.cwd(), "supabase", "migrations");
const local = new Map(
  readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const match = file.match(/^(\d+)_(.+)\.sql$/);
      if (!match) throw new Error(`Migration filename is not <version>_<name>.sql: ${file}`);
      return [match[1], { name: match[2], file }];
    }),
);

const appliedRows = await runQuery(
  "SELECT version::text AS version, name FROM supabase_migrations.schema_migrations ORDER BY version",
);
const applied = new Map(appliedRows.map((row) => [String(row.version), row.name]));

const onlyApplied = [...applied.keys()].filter((version) => !local.has(version)).sort();
const onlyLocal = [...local.keys()].filter((version) => !applied.has(version)).sort();
const matched = [...local.keys()].filter((version) => applied.has(version)).length;

console.log(`Project: ${ref}`);
console.log(`Local files: ${local.size}   Applied: ${applied.size}   Matched: ${matched}\n`);

for (const version of onlyApplied) {
  console.log(`DRIFT | applied but no local file | ${version} | ${applied.get(version) ?? "-"}`);
}
for (const version of onlyLocal) {
  console.log(`DRIFT | local file but never applied | ${version} | ${local.get(version).name}`);
}

if (!onlyApplied.length && !onlyLocal.length) {
  console.log(`OK | applied=${applied.size} local=${local.size} matched=${matched}`);
  // `process.exitCode` rather than `process.exit()`: undici keeps a keep-alive socket open, and
  // exiting from under it trips a libuv assertion on Windows ("!(handle->flags & UV_HANDLE_CLOSING)")
  // that reads as a crash next to a passing line.
  process.exitCode = 0;
} else {
  console.log(
    `\n${onlyApplied.length} applied without a file, ${onlyLocal.length} file without a row.` +
      (onlyLocal.length ? " Run `node scripts/apply-migrations.mjs <ref>` for the pending ones." : ""),
  );
  process.exitCode = 1;
}
