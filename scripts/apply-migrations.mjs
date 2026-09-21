// Applies supabase/migrations/*.sql to a hosted Supabase project, in filename order.
//
// WHY THE MANAGEMENT API AND NOT `supabase db push`
//
// `db push` is the canonical path, and it is the one to use once a database password is
// available (`supabase db push --db-url postgresql://...`). It is not usable with only a
// personal access token: the CLI first calls the project's database-config endpoint to
// mint a login role, and a token without that privilege is refused with
//
//   LegacyDbConfigLoginRoleStatusError: unexpected login role status 403
//
// The Management API's `database/query` endpoint needs no database password and no login
// role, so this script replays the same files through it.
//
// WHY IT WRITES MIGRATION HISTORY BY HAND
//
// Applying DDL without recording it would leave `supabase_migrations.schema_migrations`
// empty, which is worse than not applying at all: `db push` would then try to re-apply
// every migration, and the DDL here is not idempotent (a bare `ALTER TABLE ... ADD COLUMN`
// fails the second time). So each file is applied and recorded in one transaction, using
// the exact DDL and INSERT shape the CLI itself uses - read out of the v2.117 binary:
//
//   CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)
//   ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text
//   ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]
//   INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)
//
// `statements` is left NULL. That column was added by ALTER, so NULL is exactly what a
// version of the CLI predating it leaves behind - a legitimate value rather than a
// malformed one. The column is informational; nothing keys off it.
//
// Each migration runs as `begin; <file>; insert history; commit;`, so a file that fails
// leaves neither partial DDL nor a history row. Verified against the endpoint: a failing
// statement inside an explicit transaction rolls the whole thing back.
//
// Usage:
//   node scripts/apply-migrations.mjs <project-ref> [--dry-run] [--allow-production]
//
// Reads SUPABASE_ACCESS_TOKEN from the environment, falling back to the repository `.env`.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The go-forward production project. Refused unless --allow-production is passed, so a
// mistyped ref cannot silently migrate the live database.
const PRODUCTION_REF = "bwzemvaftzforfmaprif";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowProduction = args.includes("--allow-production");
const ref = args.find((a) => !a.startsWith("--"));

if (!ref) {
  console.error(
    "Usage: node scripts/apply-migrations.mjs <project-ref> [--dry-run] [--allow-production]",
  );
  process.exit(2);
}

if (ref === PRODUCTION_REF && !allowProduction) {
  console.error(
    `Refusing to migrate ${ref}: that is the production project.\n` +
      "Migrations are replayed onto staging first. Pass --allow-production only when the\n" +
      "cutover is actually being performed.",
  );
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
    // No .env: fall through to the error below.
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

const escapeLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

const migrationsDir = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => {
    const match = f.match(/^(\d+)_(.+)\.sql$/);
    if (!match) throw new Error(`Migration filename is not <version>_<name>.sql: ${f}`);
    return { file: f, version: match[1], name: match[2] };
  });

console.log(`Project: ${ref}${dryRun ? "  (dry run)" : ""}`);
console.log(`Migrations found: ${files.length}`);

// The CLI's own DDL, so a later `db push` sees a history table it recognises.
await runQuery(`
  CREATE SCHEMA IF NOT EXISTS supabase_migrations;
  CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
  ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;
  ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];
`);

const appliedRows = await runQuery("SELECT version FROM supabase_migrations.schema_migrations");
const applied = new Set(appliedRows.map((r) => String(r.version)));
console.log(`Already applied: ${applied.size}`);

const pending = files.filter((f) => !applied.has(f.version));
console.log(`Pending: ${pending.length}\n`);

if (dryRun) {
  for (const m of pending) console.log(`  would apply  ${m.version}  ${m.name}`);
  process.exit(0);
}

let succeeded = 0;
for (const migration of pending) {
  const body = readFileSync(join(migrationsDir, migration.file), "utf8");
  const script = [
    "begin;",
    body,
    `insert into supabase_migrations.schema_migrations(version, name, statements) values (${escapeLiteral(
      migration.version,
    )}, ${escapeLiteral(migration.name)}, null);`,
    "commit;",
  ].join("\n");

  try {
    await runQuery(script);
    succeeded += 1;
    console.log(`  applied  ${migration.version}  ${migration.name}`);
  } catch (error) {
    console.error(`\n  FAILED   ${migration.version}  ${migration.name}`);
    console.error(`           ${String(error.message).split("\n").join("\n           ")}`);
    console.error(
      `\nStopped at the first failure. ${succeeded} applied before it. Nothing from this\n` +
        "migration was committed. Fix the file, then re-run - applied versions are skipped.",
    );
    process.exit(1);
  }
}

console.log(`\nApplied ${succeeded}. Skipped ${files.length - succeeded} already present.`);
const total = await runQuery("SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations");
console.log(`Recorded in supabase_migrations: ${total[0]?.n}`);
