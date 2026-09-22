#!/usr/bin/env node
/**
 * Restores a backup into the local stack, proving the backup is usable.
 *
 * ## Why this exists
 *
 * A backup nobody has restored is a hope. `pg_restore` exiting 0 only says the file was
 * readable; it does not say the data arrived, and it certainly does not say the application
 * can read it. This is the drill that closes the loop, and the local stack is the right
 * place for it: disposable, costs nothing, and cannot endanger the real data.
 *
 * ## What it proves, and what it does not
 *
 * The recovery procedure for this project is *migrations rebuild the schema, the backup
 * restores the data* — so this runs `supabase db reset` first, which replays every migration
 * into a fresh database, and only then loads the dump. That mirrors a real recovery rather
 * than approximating it.
 *
 * It does not prove the schema is complete: `pg_restore` is told `--data-only`, so the dump
 * contributes rows, not definitions. Schema correctness is the migrations' job, and the
 * migration replay here is what checks it.
 *
 * ## Usage
 *
 *   npm run restore:to-local -- backups/tournova-<ref>-<stamp>.dump --yes
 *
 * The local database is DESTROYED, so `--yes` is required and the target is refused unless
 * it is the local stack.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** The local stack's database, as `supabase start` reports it. */
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * The local stack's superuser, used only for the data load.
 *
 * `postgres` owns the database but is deliberately **not** a superuser (`rolsuper=false`),
 * so it cannot disable the internal constraint triggers — the attempt fails with
 * `permission denied: "RI_ConstraintTrigger_..." is a system trigger`, and every
 * foreign-key-dependent table then fails to load. Setting `session_replication_role` is
 * refused too when it is passed as a connection parameter rather than set in-session.
 * `supabase_admin` is the superuser that exists for exactly this kind of administrative
 * work, and it is local-only, so using it here costs nothing.
 */
const LOCAL_ADMIN_URL = "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres";
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

function each(url, sql, psql) {
  return execFileSync(psql, [url, "-tAc", sql], { encoding: "utf8" }).trim();
}

function tableCounts(psql) {
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
  return JSON.parse(each(LOCAL_URL, query, psql));
}

function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const pathArg = args.find((a) => !a.startsWith("--"));

  if (!pathArg) {
    fail("Usage: npm run restore:to-local -- <dump path> --yes");
  }

  const dumpPath = isAbsolute(pathArg) ? pathArg : join(ROOT, pathArg);
  if (!existsSync(dumpPath)) fail(`No dump at ${pathArg}`);

  // The target is hardcoded local, and asserted rather than assumed: this script deletes
  // everything in its target, so it must be incapable of pointing anywhere else.
  const host = new URL(LOCAL_URL.replace(/^postgresql:/, "http:")).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    fail(`Refusing to run: the configured target (${host}) is not the local stack.`);
  }

  if (!confirmed) {
    fail(
      "This destroys the local database (it is rebuilt from migrations and then overwritten\n" +
        `with the dump's data). Re-run with --yes to confirm:\n\n` +
        `  npm run restore:to-local -- ${pathArg} --yes\n`,
    );
  }

  const psql = tool("psql");
  const pgRestore = tool("pg_restore");

  // Reachability first: `db reset` failing after a long migration replay is a worse
  // experience than being told the stack is simply not running.
  try {
    each(LOCAL_URL, "select 1", psql);
  } catch {
    fail(
      "The local stack is not reachable at 127.0.0.1:54322.\n\n" +
        "  colima start\n" +
        "  npx supabase start\n",
    );
  }

  console.log("  rebuilding the local schema from migrations...");
  execFileSync("npx", ["supabase", "db", "reset"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });

  // Migrations bring their own baseline rows (the demo tournament), which would collide
  // with the dump's primary keys. Truncate so the dump is the only source of data.
  const tables = each(
    LOCAL_URL,
    "select string_agg(format('%I.%I', schemaname, tablename), ', ') from pg_tables where schemaname = 'public'",
    psql,
  );
  if (tables) each(LOCAL_URL, `truncate table ${tables} cascade`, psql);
  console.log("  truncated the migration baseline");

  console.log("  restoring the dump (data only)...");
  execFileSync(
    pgRestore,
    [
      "--data-only",
      "--schema=public",
      "--no-owner",
      "--no-privileges",
      // Row order in a data-only dump is not foreign-key order, so constraint triggers are
      // suppressed for the load rather than relied upon. This is the documented flag, and it
      // is why the load connects as the superuser above.
      "--disable-triggers",
      "--dbname",
      LOCAL_ADMIN_URL,
      dumpPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  const countsPath = `${dumpPath}.counts.json`;
  if (!existsSync(countsPath)) {
    console.log("\n  restored, but no counts sidecar was found to check against.");
    console.log("  Re-take the backup with scripts/backup-production.mjs to enable verification.");
    return;
  }

  const expected = JSON.parse(readFileSync(countsPath, "utf8"));
  const actual = tableCounts(psql);

  const mismatches = Object.keys(expected).filter(
    (table) => Number(actual[table] ?? -1) !== Number(expected[table]),
  );

  const total = Object.values(actual).reduce((sum, n) => sum + Number(n), 0);
  console.log(`\n  tables restored : ${Object.keys(actual).length}`);
  console.log(`  rows            : ${total}`);

  if (mismatches.length > 0) {
    console.log("\n  MISMATCHES (table: expected -> actual)");
    for (const table of mismatches) {
      console.log(`    ${table}: ${expected[table]} -> ${actual[table] ?? "(missing)"}`);
    }
    fail(
      "The restore did not reproduce the backed-up row counts. Treat the backup as unproven\n" +
        "and investigate before relying on it.",
    );
  }

  console.log("  every table matches the backup's recorded counts");

  const tournaments = each(LOCAL_URL, "select string_agg(name, ', ' order by name) from public.tournaments", psql);
  console.log(`  tournaments     : ${tournaments || "(none)"}`);
  console.log("\n  restore verified");
}

main();
