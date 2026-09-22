#!/usr/bin/env node
/**
 * Takes a logical backup of a hosted project's `public` schema.
 *
 * ## Why this exists
 *
 * The new production project has no retained backups and no PITR (`{pitr_enabled: false,
 * backups: []}`), and the Lovable Cloud project this repository migrated away from is not in
 * the account — so it cannot stand in as a restore point. That leaves no recovery path at
 * all, and the migrations are not one: `20260910043000_reconstruct_demo_tournament_data.sql`
 * opens by deleting every player, team, pool, entry and draw.
 *
 * The data that matters is what operators enter during an event. None of it is regenerable.
 *
 * ## Scope, and what is deliberately excluded
 *
 * `public` only. The recovery procedure is *migrations rebuild the schema, this restores the
 * data*, so functions, policies and triggers are not backed up here — they live in
 * `supabase/migrations`, which is the source of truth for them.
 *
 * `auth` is excluded on purpose. The staff accounts it holds are recreated by
 * `scripts/create-staff-login.mjs`, which is the documented and tested path, and a partial
 * `auth` restore is not something to attempt during an incident.
 *
 * ## Usage
 *
 *   SUPABASE_DB_PASSWORD=... npm run backup:production
 *   SUPABASE_DB_PASSWORD=... npm run backup:production -- --project-ref <ref>
 *
 * The target defaults to the production project named in `.env.production`, and is printed
 * before anything is read, because "which database did this dump?" is the one question a
 * backup must never leave ambiguous.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT_DIR = join(ROOT, "backups");

/** Session mode. See `sessionUrl()` for why the transaction pooler cannot be used. */
const SESSION_PORT = 5432;

function fail(message) {
  throw new Error(message);
}

/** Reads the first `KEY=value` for `key` from a file, or undefined. Never logs the value. */
function readValue(file, key) {
  if (!existsSync(file)) return undefined;
  const match = readFileSync(file, "utf8").match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]*)"?`, "m"));
  return match?.[1]?.trim() || undefined;
}

function projectRef(url) {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return undefined;
  }
}

/**
 * The default target: the project the production build is configured to talk to.
 *
 * Read from `.env.production` rather than hardcoded, so it follows the repository's own
 * configuration instead of drifting from it.
 */
function defaultRef() {
  const url = readValue(join(ROOT, ".env.production"), "VITE_SUPABASE_URL");
  return url ? projectRef(url) : undefined;
}

function password() {
  const fromEnv = process.env["SUPABASE_DB_PASSWORD"]?.trim();
  if (fromEnv) return fromEnv;

  // `.env.local` is git-ignored and is the natural place for a credential you must not
  // commit. Checked after the environment so an explicit export always wins.
  for (const file of [".env.local", ".env"]) {
    const value = readValue(join(ROOT, file), "SUPABASE_DB_PASSWORD");
    if (value) return value;
  }

  fail(
    "SUPABASE_DB_PASSWORD is not set.\n\n" +
      "pg_dump authenticates as the database role, so a publishable key will not work. Get\n" +
      "the database password from the dashboard (Project Settings -> Database) and either\n" +
      "export it or put it in `.env.local` (git-ignored):\n\n" +
      "  SUPABASE_DB_PASSWORD=... npm run backup:production\n",
  );
}

/** Resolves a Postgres client binary, preferring PATH and falling back to Homebrew's libpq. */
function tool(name) {
  const candidates = [
    process.env[`${name.toUpperCase()}_BIN`],
    name,
    `/opt/homebrew/opt/libpq/bin/${name}`,
    `/usr/local/opt/libpq/bin/${name}`,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }

  fail(
    `Could not find \`${name}\`.\n\n` +
      "This is not the Supabase CLI -- pg_dump ships with the Postgres client tools:\n\n" +
      "  brew install libpq\n" +
      "  export PATH=/opt/homebrew/opt/libpq/bin:$PATH\n",
  );
}

/**
 * The pooler host and role for a project, from the Management API.
 *
 * Looked up rather than hardcoded so the region cannot go stale, and because the pooler
 * hostname encodes it (`aws-0-us-west-2...`), which is exactly the kind of detail that
 * silently points at the wrong place after a project moves.
 */
async function poolerConfig(ref) {
  const token = process.env["SUPABASE_ACCESS_TOKEN"]?.trim() ?? readValue(join(ROOT, ".env"), "SUPABASE_ACCESS_TOKEN");
  if (!token) {
    fail(
      "SUPABASE_ACCESS_TOKEN is not set, so the pooler host cannot be looked up.\n" +
        "It is needed to resolve the connection details; the password is used only for the dump.",
    );
  }

  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/database/pooler`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    fail(
      `Could not read the pooler configuration for ${ref}: HTTP ${response.status}.\n` +
        "Check the ref, and that the access token belongs to the account that owns it.",
    );
  }

  const body = await response.json();
  const config = Array.isArray(body) ? body[0] : body;
  if (!config?.db_host || !config?.db_user) fail(`Unexpected pooler response for ${ref}.`);
  return config;
}

/**
 * A dump-capable connection string.
 *
 * The pooler's default port is 6543, which is *transaction* mode: each statement may run on
 * a different backend connection. `pg_dump` needs a consistent snapshot, so it must use the
 * session-mode port. Getting this wrong produces a dump that fails partway rather than an
 * obvious error about the wrong mode, so it is forced here rather than trusted.
 */
function sessionUrl(config, secret) {
  const auth = `${config.db_user}:${encodeURIComponent(secret)}`;
  return `postgresql://${auth}@${config.db_host}:${SESSION_PORT}/${config.db_name ?? "postgres"}`;
}

/**
 * Exact row counts for every table in `public`.
 *
 * Recorded alongside the dump so a restore can be *checked* rather than assumed. A
 * `pg_restore` exit code of 0 says the file was readable, not that the data arrived.
 */
function countsFor(url, psql) {
  const query = `
    select coalesce(json_object_agg(relname, n), '{}'::json)
    from (
      select c.relname,
             (xpath('/row/c/text()',
                    query_to_xml(format('select count(*) as c from public.%I', c.relname),
                                 false, true, '')))[1]::text::bigint as n
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r'
    ) s;
  `;
  const out = execFileSync(psql, [url, "-tAc", query], { encoding: "utf8" });
  return JSON.parse(out.trim());
}

async function main() {
  const args = process.argv.slice(2);
  const refFlag = args.indexOf("--project-ref");
  const ref = refFlag !== -1 ? args[refFlag + 1] : defaultRef();

  if (!ref) {
    fail(
      "No target project.\n" +
        "Pass --project-ref <ref>, or set VITE_SUPABASE_URL in .env.production.",
    );
  }

  // A dump of staging is not harmful, but it is not what was asked for either, and the two
  // refs are easy to mix up when copying one from the dashboard.
  const stagingRef = readValue(join(ROOT, ".env"), "VITE_SUPABASE_PROJECT_ID");
  if (stagingRef && ref === stagingRef) {
    fail(`Refusing to run: ${ref} is the staging project, not production.`);
  }

  const secret = password();
  const config = await poolerConfig(ref);
  const url = sessionUrl(config, secret);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(OUT_DIR, { recursive: true });
  const dumpPath = join(OUT_DIR, `tournova-${ref}-${stamp}.dump`);
  const countsPath = `${dumpPath}.counts.json`;

  console.log(`backing up  : ${ref}  (${config.db_host}, session port ${SESSION_PORT})`);
  console.log(`writing     : ${dumpPath.replace(ROOT + "/", "")}`);

  const pgDump = tool("pg_dump");
  const psql = tool("psql");

  // --no-owner/--no-privileges: the roles that own these objects on a hosted project do not
  // exist on the machine doing a restore, and ownership is not part of the data.
  execFileSync(
    pgDump,
    [url, "--format=custom", "--schema=public", "--no-owner", "--no-privileges", "--file", dumpPath],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  const counts = countsFor(url, psql);
  writeFileSync(countsPath, `${JSON.stringify(counts, null, 2)}\n`);

  // Reads the dump's own table of contents. This is the cheapest possible proof that the
  // bytes on disk are a dump we could restore, and it is worth doing now rather than
  // discovering otherwise during an incident.
  const listing = execFileSync(tool("pg_restore"), ["--list", dumpPath], { encoding: "utf8" });
  const entries = listing.split("\n").filter((line) => /^\d+;/.test(line)).length;

  const size = statSync(dumpPath).size;
  const total = Object.values(counts).reduce((sum, n) => sum + Number(n), 0);

  console.log(`tables      : ${Object.keys(counts).length}`);
  console.log(`rows        : ${total}`);
  console.log(`dump size   : ${(size / 1024).toFixed(1)} kB`);
  console.log(`toc entries : ${entries}  (readable by pg_restore)`);
  console.log(`counts      : ${countsPath.replace(ROOT + "/", "")}`);
  console.log("\nrestore it with:  npm run restore:to-local -- " + dumpPath.replace(ROOT + "/", ""));
}

await main();
