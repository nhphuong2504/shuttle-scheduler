// Runs one read-only .sql file and prints the result as TSV.
//
// Why this exists: `scripts/parity-dump.sql` and `scripts/migration-drift-check.sql` are
// catalog queries that need a real Postgres connection, and `psql` is not a safe assumption -
// it is absent on a stock macOS and on the Windows box this repository has PowerShell scripts
// for. The Supabase CLI cannot stand in either: its `db` subcommand set is
// diff/dump/push/pull/reset, with no way to execute a file.
//
// TWO TRANSPORTS, because the two are available under different conditions:
//
//   1. Direct connection, when a database password is available:
//        SUPABASE_DB_URL='postgresql://...' node scripts/run-sql.mjs scripts/parity-dump.sql
//
//   2. Management API, when only a personal access token is available - which is the case
//      during this migration, where no database password exists for either new project:
//        node scripts/run-sql.mjs scripts/parity-dump.sql --project-ref <ref>
//
//      The token is read from SUPABASE_ACCESS_TOKEN, falling back to the repository `.env`.
//
// `SUPABASE_DB_URL` is the Postgres connection string (the dashboard's Connect panel), not the
// `https://<ref>.supabase.co` API URL and not the publishable key.
//
// This deliberately refuses anything that is not a single read-only statement. The scripts here
// are read-only, but they are pointed at a project with a privileged connection string -
// including, for the drift check, the live one - so the runner is the place to make that
// guarantee rather than trusting each caller.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const refIndex = argv.indexOf("--project-ref");
const projectRef = refIndex === -1 ? undefined : argv[refIndex + 1];
if (refIndex !== -1 && !projectRef) {
  console.error("--project-ref needs a project ref.");
  process.exit(2);
}
const file = argv.find((a) => !a.startsWith("--") && a !== projectRef);

if (!file) {
  console.error("Usage: node scripts/run-sql.mjs <file.sql> [--project-ref <ref>]");
  process.exit(2);
}

const sql = readFileSync(file, "utf8");

// Strip comments and string literals before deciding what the statement is, so a leading
// comment or a ';' inside a literal cannot disguise the verb.
const bare = sql
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/--[^\n]*/g, " ")
  .replace(/'(?:[^']|'')*'/g, "''")
  .trim();

if (!/^(select|with|values|table)\b/i.test(bare)) {
  console.error(`Refusing to run ${file}: it does not begin with a read-only statement.`);
  process.exit(2);
}

const statements = bare
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

if (statements.length !== 1) {
  console.error(
    `Refusing to run ${file}: expected exactly one statement, found ${statements.length}.`,
  );
  process.exit(2);
}

function printRows(rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const out = [columns.join("\t")];
  for (const row of rows) {
    out.push(columns.map((name) => String(row[name] ?? "")).join("\t"));
  }
  process.stdout.write(out.join("\n") + "\n");
}

if (projectRef) {
  const token =
    process.env["SUPABASE_ACCESS_TOKEN"]?.trim() ??
    readFileSync(join(process.cwd(), ".env"), "utf8").match(
      /^\s*SUPABASE_ACCESS_TOKEN\s*=\s*"?([^"\n]+)"?\s*$/m,
    )?.[1]?.trim();

  if (!token) {
    console.error("No access token. Set SUPABASE_ACCESS_TOKEN, or put it in the repository .env.");
    process.exit(2);
  }

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).message ?? text;
    } catch {
      // Keep the raw body.
    }
    console.error(`Failed to run ${file}: ${detail.trim()}`);
    process.exit(1);
  }
  printRows(JSON.parse(text));
  process.exit(0);
}

const connectionString =
  process.env["SUPABASE_DB_URL"] || process.env["DATABASE_URL"] || process.env["SUPABASE_DB_URL_TEST"];
if (!connectionString) {
  console.error(
    "No connection string. Set SUPABASE_DB_URL to the project's Postgres connection string,\n" +
      "or pass --project-ref <ref> to go through the Management API with SUPABASE_ACCESS_TOKEN.\n" +
      "The Supabase dashboard's Connect panel has the connection string; it is not the\n" +
      "https://<ref>.supabase.co URL.",
  );
  process.exit(2);
}

const { Client } = await import("pg");

// pg honours `sslmode` when it is in the string. Where it is absent, Supabase still requires
// TLS, so enable it rather than sending credentials in the clear.
const needsExplicitSsl = !/[?&]sslmode=/.test(connectionString);
const client = new Client({
  connectionString,
  ...(needsExplicitSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

try {
  await client.connect();
  const { rows, fields } = await client.query(sql);
  printRows(rows.map((row) => Object.fromEntries(fields.map((f) => [f.name, row[f.name]]))));
} catch (error) {
  console.error(`Failed to run ${file}: ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
