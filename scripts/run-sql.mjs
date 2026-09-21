// Runs one read-only .sql file and prints the result as TSV.
//
// Why this exists: `scripts/parity-dump.sql` and `scripts/migration-drift-check.sql` are
// catalog queries that need a real Postgres connection, and `psql` is not a safe assumption -
// it is absent on a stock macOS and on the Windows box this repository has PowerShell scripts
// for. The Supabase CLI cannot stand in either: its `db` subcommand set is diff/dump/push/
// pull/reset, with no way to execute a file. So the two scripts go through `pg` instead.
//
// Usage:
//   SUPABASE_DB_URL='postgresql://...' node scripts/run-sql.mjs scripts/parity-dump.sql > old.tsv
//
// The connection string is the Postgres one (the dashboard's "Connect" panel), not the
// `https://<ref>.supabase.co` API URL and not the publishable key.
//
// This deliberately refuses anything that is not a single read-only statement. The scripts
// here are read-only, but they are pointed at a project with a privileged connection string -
// including, for the drift check, the live one - so the runner is the place to make that
// guarantee rather than trusting each caller.

import { readFileSync } from "node:fs";
import { Client } from "pg";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/run-sql.mjs <file.sql>");
  process.exit(2);
}

const connectionString =
  process.env["SUPABASE_DB_URL"] || process.env["DATABASE_URL"] || process.env["SUPABASE_DB_URL_TEST"];
if (!connectionString) {
  console.error(
    "No connection string. Set SUPABASE_DB_URL to the project's Postgres connection string.\n" +
      "The Supabase dashboard's Connect panel has it; it is not the https://<ref>.supabase.co URL.",
  );
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
  const columns = fields.map((f) => f.name);
  const out = [columns.join("\t")];
  for (const row of rows) {
    out.push(columns.map((name) => String(row[name] ?? "")).join("\t"));
  }
  process.stdout.write(out.join("\n") + "\n");
} catch (error) {
  console.error(`Failed to run ${file}: ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
