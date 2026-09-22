#!/usr/bin/env node
/**
 * Restores a `pg_dump` backup into a database whose schema already exists.
 *
 * ## Why this exists
 *
 * A backup nobody has restored is a hope. `pg_restore` exiting 0 says the file was
 * readable; it does not say the data arrived, and it certainly does not say the application
 * can read it. This is the drill that closes the loop, and the same code path is used
 * against the local stack and against a hosted project so the drill exercises what a real
 * recovery would actually run.
 *
 * See `docs/recovery-runbook.md` for the procedure this implements and what it does not
 * cover.
 *
 * ## Why loading order is the hard part
 *
 * A data-only restore lands rows into a schema that already has its constraints and
 * triggers, and this schema has two things that make the dump's own order unusable:
 *
 *   1. **Foreign keys.** The dump's tables are ordered alphabetically, so `categories` is
 *      restored before the `tournaments` row it references. Against a full production dump,
 *      29 of 50 foreign key relationships are out of order.
 *
 *   2. **Triggers that derive columns.** `pool_entries_membership` is a BEFORE INSERT
 *      trigger that reads `tournament_id` from `pools` and writes it onto the new row. If
 *      `pools` has not been loaded yet it writes NULL, and the row is rejected by a NOT NULL
 *      constraint. Dropping the foreign keys does not help with this at all - it was found
 *      by dropping exactly those keys and watching `pool_entries` load 0 of 145 rows.
 *
 * So the load is made order-independent rather than ordered:
 *
 *   - the 54 foreign key constraints are dropped, then re-added afterwards. `ADD CONSTRAINT`
 *     validates every existing row, so re-adding is itself an integrity check.
 *   - user triggers are disabled for the duration, then re-enabled.
 *
 * `ALTER TABLE ... DISABLE TRIGGER USER` is permitted to the **table owner**, not a
 * superuser, which is what makes this work on a hosted project. `pg_restore
 * --disable-triggers` and `SET session_replication_role` both require superuser and are
 * refused there (`ERROR: 42501`), and `postgres` on a hosted project is not a superuser.
 *
 * ## Usage
 *
 *   npm run restore:to-local -- backups/<dump> --yes
 *   node scripts/restore-backup.mjs <dump> --project-ref <ref> [--allow-production] --yes
 *
 * The target defaults to the local stack and the local database is DESTROYED, so `--yes` is
 * required. A hosted target additionally has to be named explicitly.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** The local stack's database, as `supabase start` reports it. */
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** Session mode. The transaction pooler cannot hold the session this needs. */
const SESSION_PORT = 5432;

const PRODUCTION_REF = "bwzemvaftzforfmaprif";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function fail(message) {
  throw new Error(message);
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
    `Could not find \`${name}\`.\n` +
      "Install the Postgres client tools: `brew install libpq`, then add its bin to PATH.",
  );
}

/** Reads the first `KEY=value` for `key` from a file, or undefined. Never logs the value. */
function readValue(file, key) {
  if (!existsSync(file)) return undefined;
  const match = readFileSync(file, "utf8").match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]*)"?`, "m"));
  return match?.[1]?.trim() || undefined;
}

/**
 * The pooler host and role for a hosted project, from the Management API.
 *
 * Looked up rather than hardcoded so the region cannot go stale - and the pooler hostname
 * encodes the region, which is exactly the detail that silently points at the wrong place
 * after a project moves.
 */
async function poolerConfig(ref) {
  const token =
    process.env["SUPABASE_ACCESS_TOKEN"]?.trim() ?? readValue(join(ROOT, ".env"), "SUPABASE_ACCESS_TOKEN");
  if (!token) {
    fail("SUPABASE_ACCESS_TOKEN is not set, so the pooler host cannot be looked up.");
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

function password() {
  const fromEnv = process.env["SUPABASE_DB_PASSWORD"]?.trim();
  if (fromEnv) return fromEnv;
  for (const file of [".env.local", ".env"]) {
    const value = readValue(join(ROOT, file), "SUPABASE_DB_PASSWORD");
    if (value) return value;
  }
  fail(
    "SUPABASE_DB_PASSWORD is not set.\n\n" +
      "pg_restore authenticates as the database role, so a publishable key will not work.\n" +
      "Export it, or put it in `.env.local` (git-ignored).",
  );
}

/**
 * The per-table row counts of what is actually inside the dump.
 *
 * Derived from the archive rather than read from the `.counts.json` sidecar, so the numbers
 * checked against are a property of the file being restored. The sidecar can be stale or
 * absent; the dump cannot disagree with itself.
 */
function countsInDump(dump, pgRestore) {
  // `pg_restore -f -` emits the data as plain SQL in the archive's own order.
  const plain = execFileSync(pgRestore, ["-f", "-", "--data-only", dump], { encoding: "utf8" });
  const counts = {};
  let current = null;
  for (const line of plain.split("\n")) {
    const copy = line.match(/^COPY public\.(\w+) /);
    if (copy) {
      current = copy[1];
      counts[current] = 0;
    } else if (line === "\\.") {
      current = null;
    } else if (current !== null) {
      counts[current] += 1;
    }
  }
  return counts;
}

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const allowProduction = args.includes("--allow-production");
  const refIndex = args.indexOf("--project-ref");
  const ref = refIndex === -1 ? undefined : args[refIndex + 1];
  const pathArg = args.find((a) => !a.startsWith("--") && a !== ref);

  if (!pathArg) {
    fail(
      "Usage: npm run restore:to-local -- <dump path> --yes\n" +
        "       node scripts/restore-backup.mjs <dump path> --project-ref <ref> --yes",
    );
  }

  const dump = isAbsolute(pathArg) ? pathArg : join(ROOT, pathArg);
  if (!existsSync(dump)) fail(`No dump at ${pathArg}`);

  let url = LOCAL_URL;
  let label = "the local stack";

  if (ref) {
    if (ref === PRODUCTION_REF && !allowProduction) {
      fail(
        `Refusing to restore into ${ref}: that is the production project.\n` +
          "Rehearse against the local stack or staging first. Pass --allow-production only\n" +
          "when a recovery is actually being performed.",
      );
    }
    const config = await poolerConfig(ref);
    url = `postgresql://${config.db_user}:${encodeURIComponent(password())}@${config.db_host}:${SESSION_PORT}/${config.db_name ?? "postgres"}`;
    label = `the hosted project ${ref}`;
  } else {
    // Asserted rather than assumed: this script deletes everything it can reach.
    const host = new URL(LOCAL_URL.replace(/^postgresql:/, "http:")).hostname;
    if (!LOCAL_HOSTS.has(host)) fail(`Refusing to run: the configured target (${host}) is not local.`);
  }

  if (!confirmed) {
    fail(
      `This destroys every row in ${label} (the schema is kept and the dump's data is\n` +
        `loaded over it). Re-run with --yes to confirm:\n\n` +
        `  ${ref ? "node scripts/restore-backup.mjs" : "npm run restore:to-local --"} ${pathArg} --yes\n`,
    );
  }

  const psql = tool("psql");
  const pgRestore = tool("pg_restore");

  const query = (sql, target = url) =>
    execFileSync(psql, [target, "-tAc", sql], { encoding: "utf8" }).trim();

  const expected = countsInDump(dump, pgRestore);
  const expectedTotal = Object.values(expected).reduce((sum, n) => sum + Number(n), 0);

  console.log(`restoring  : ${dump.replace(ROOT + "/", "")}`);
  console.log(`into       : ${label}`);
  console.log(`dump holds : ${Object.keys(expected).length} tables, ${expectedTotal} rows`);

  // Reachability first: discovering the target is unreachable after a long migration replay
  // is a worse experience than being told now.
  try {
    query("select 1");
  } catch (error) {
    if (ref) fail(`Could not reach ${ref}: ${String(error.message).split("\n")[0]}`);
    fail(
      "The local stack is not reachable at 127.0.0.1:54322.\n\n" +
        "  colima start\n" +
        "  npx supabase start\n",
    );
  }

  // The schema has to exist before the data can land in it. For a hosted target that means
  // the migrations have been applied; this script deliberately does not apply them, because
  // "rebuild the schema" and "overwrite the data" are separate decisions.
  const tables = query(
    "select string_agg(format('%I', tablename), ', ') from pg_tables where schemaname = 'public'",
  );
  if (!tables) {
    fail(
      "The target has no tables in `public`, so there is no schema for the data to land in.\n" +
        (ref
          ? `Apply the migrations first:  node scripts/apply-migrations.mjs ${ref}`
          : "Rebuild the local schema first:  npx supabase db reset"),
    );
  }

  const tableNames = query("select tablename from pg_tables where schemaname = 'public' order by 1")
    .split("\n")
    .filter(Boolean);

  console.log("\nemptying every table in public");
  query(`truncate table ${tables} cascade`);

  // Captured before anything is dropped: these are the definitions that get put back.
  const fks = query(`
    select c.relname || '|' || con.conname || '|' || pg_get_constraintdef(con.oid)
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f' and n.nspname = 'public'
    order by c.relname, con.conname
  `)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [table, name, definition] = line.split("|");
      return { table, name, definition };
    });

  // Written to a file as well as held in memory: if this script is interrupted after the
  // constraints are dropped, this is the only record of how to put them back.
  const repairPath = `${dump}.repair.sql`;
  writeFileSync(
    repairPath,
    [
      "-- Run this if a restore was interrupted after the constraints were dropped.",
      ...fks.map((fk) => `alter table public."${fk.table}" add constraint "${fk.name}" ${fk.definition};`),
      ...tableNames.map((t) => `alter table public."${t}" enable trigger user;`),
      "",
    ].join("\n"),
  );

  console.log(`making the load order-independent`);
  for (const fk of fks) query(`alter table public."${fk.table}" drop constraint "${fk.name}"`);
  for (const table of tableNames) query(`alter table public."${table}" disable trigger user`);
  console.log(`  dropped ${fks.length} foreign keys, disabled user triggers on ${tableNames.length} tables`);

  let restored = true;
  try {
    // --no-owner/--no-privileges: the roles that own these objects on a hosted project do
    // not exist on the machine doing a restore, and ownership is not part of the data.
    const result = spawnSync(
      pgRestore,
      ["--data-only", "--no-owner", "--no-privileges", "--dbname", url, dump],
      { encoding: "utf8" },
    );
    // pg_restore exits non-zero when any COPY failed, and it also *warns* rather than failing
    // for several conditions, so both signals are treated as a failure.
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const failures = output.split("\n").filter((line) => /COPY failed|error:/i.test(line));
    if (result.status !== 0 || failures.length) {
      restored = false;
      console.log(`\n  the dump did not load cleanly (exit ${result.status}):`);
      for (const line of failures.slice(0, 5)) console.log(`    ${line.trim()}`);
    } else {
      console.log("  loaded the whole dump in one pass");
    }
  } finally {
    // Always put the schema back into its enforcing state, even if the load failed - a
    // database left with its constraints dropped is worse than a failed restore.
    console.log("\nrestoring constraints and triggers");
    for (const table of tableNames) query(`alter table public."${table}" enable trigger user`);
    for (const fk of fks) query(`alter table public."${fk.table}" add constraint "${fk.name}" ${fk.definition}`);
    console.log(`  re-added ${fks.length} foreign keys (each one validates every row as it is added)`);
  }

  const actual = Object.fromEntries(
    Object.keys(expected).map((t) => [t, Number(query(`select count(*) from "${t}"`))]),
  );
  const mismatches = Object.keys(expected).filter((t) => actual[t] !== Number(expected[t]));
  const total = Object.values(actual).reduce((sum, n) => sum + Number(n), 0);

  console.log(`\n  tables restored : ${Object.keys(actual).length}`);
  console.log(`  rows            : ${total} of ${expectedTotal} in the dump`);

  if (mismatches.length) {
    console.log("  MISMATCHES (table: in dump -> restored)");
    for (const table of mismatches) console.log(`    ${table}: ${expected[table]} -> ${actual[table] ?? "(missing)"}`);
    fail(
      "The restore did not reproduce the dump's row counts. Treat the backup as unproven\n" +
        "and investigate before relying on it.",
    );
  }

  if (!restored) {
    fail("The counts line up but pg_restore reported errors; do not treat this dump as proven.");
  }

  console.log("  every table matches the dump");
  const tournaments = query("select string_agg(name, ', ' order by name) from public.tournaments");
  console.log(`  tournaments     : ${tournaments || "(none)"}`);
  console.log(`\n  restore verified. Repair script, if you ever need it: ${repairPath.replace(ROOT + "/", "")}`);
  if (ref) {
    console.log(
      "\n  Reminder: a dump carries no logins. Staff cannot sign in until their accounts are\n" +
        "  recreated with scripts/create-staff-login.mjs.",
    );
  }
}

await main();
