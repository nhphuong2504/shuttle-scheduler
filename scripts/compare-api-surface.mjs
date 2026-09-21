// Compares the API surface of two Supabase backends using only their keys.
//
// WHY THIS EXISTS
//
// `scripts/parity-dump.sql` is the better tool - it compares function bodies, policy
// expressions, triggers, ACLs and database settings, none of which are visible over HTTP. It
// needs a Postgres connection string. Lovable Cloud exposes no database dashboard and no
// connection string, so the hosted project cannot be reached that way and the definition
// dump cannot be run against it.
//
// PostgREST serves its own OpenAPI document at the REST root, enumerating every exposed table
// and view with every column and its Postgres type, and every exposed RPC with its argument
// names, types and required flags. That is obtainable with a key, so it is what can actually
// be compared. It is a narrower claim than a definition dump: RPC *bodies*, policy *qual*
// expressions and trigger definitions are not visible here at all.
//
// Usage:
//   node scripts/compare-api-surface.mjs <old-url> <old-key> <new-url> <new-key>
//
// or, to read the four values from the repository `.env` and `integration/.env`:
//   node scripts/compare-api-surface.mjs
//
// Note that the two ends do not always accept the same kind of key. A current Supabase
// project refuses the REST root to a publishable key with `401 Secret API key required`,
// while the Lovable Cloud backend still serves it to one. Pass whichever key each end
// accepts; the document describes the schema either way.
//
// Exits non-zero when the surfaces differ, so it can be used as a gate.

import { readFileSync } from "node:fs";

function readEnv(path) {
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

function resolveTargets() {
  const [oldUrl, oldKey, newUrl, newKey] = process.argv.slice(2);
  if (oldUrl && oldKey && newUrl && newKey) {
    return [
      { label: "old", url: oldUrl, key: oldKey },
      { label: "new", url: newUrl, key: newKey },
    ];
  }
  if (oldUrl) {
    console.error(
      "Give either all four values or none:\n" +
        "  node scripts/compare-api-surface.mjs <old-url> <old-key> <new-url> <new-key>",
    );
    process.exit(2);
  }
  const oldEnv = readEnv(".env");
  const newEnv = readEnv("integration/.env");
  return [
    {
      label: "old (from .env)",
      url: oldEnv["VITE_SUPABASE_URL"] || oldEnv["SUPABASE_URL"],
      key: oldEnv["VITE_SUPABASE_PUBLISHABLE_KEY"] || oldEnv["SUPABASE_PUBLISHABLE_KEY"],
    },
    {
      label: "new (from integration/.env)",
      url: newEnv["SUPABASE_TEST_URL"],
      key: newEnv["SUPABASE_TEST_SERVICE_ROLE_KEY"],
    },
  ];
}

const targets = resolveTargets();
for (const target of targets) {
  if (!target.url || !target.key) {
    console.error(`Missing URL or key for the ${target.label} target.`);
    process.exit(2);
  }
}

async function fetchSpec({ url, key }) {
  const response = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${url}/rest/v1/ -> ${response.status} ${body.slice(0, 120)}`);
  return JSON.parse(body);
}

/** Every exposed table or view, with each column's reported type and format. */
function columns(spec) {
  const out = {};
  for (const [table, definition] of Object.entries(spec.definitions ?? {})) {
    const fields = {};
    for (const [column, meta] of Object.entries(definition.properties ?? {})) {
      // `description` carries the Postgres type for a scalar and the target table for a
      // foreign key, so keeping it distinguishes `text` from a FK to another table.
      fields[column] = [meta.format ?? "", meta.type ?? "", meta.description ?? ""].join("|");
    }
    out[table] = fields;
  }
  return out;
}

/** Every exposed RPC, with its argument names, types and required flags. */
function rpcs(spec) {
  const out = {};
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    if (!path.startsWith("/rpc/")) continue;
    const post = methods.post;
    if (!post) continue;
    const schema = post.parameters?.[0]?.schema ?? {};
    out[path.slice("/rpc/".length)] = {
      args: Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([arg, meta]) => [
          arg,
          `${meta.format ?? ""}:${meta.type ?? ""}`,
        ]),
      ),
      required: [...(schema.required ?? [])].sort(),
    };
  }
  return out;
}

const [oldSpec, newSpec] = await Promise.all(targets.map(fetchSpec));
const oldColumns = columns(oldSpec);
const newColumns = columns(newSpec);
const oldRpcs = rpcs(oldSpec);
const newRpcs = rpcs(newSpec);

const countColumns = (map) => Object.values(map).reduce((n, fields) => n + Object.keys(fields).length, 0);

console.log(`${targets[0].label}: ${Object.keys(oldColumns).length} tables/views, ${countColumns(oldColumns)} columns, ${Object.keys(oldRpcs).length} RPCs`);
console.log(`${targets[1].label}: ${Object.keys(newColumns).length} tables/views, ${countColumns(newColumns)} columns, ${Object.keys(newRpcs).length} RPCs`);

let differences = 0;
const report = (what, detail) => {
  differences += 1;
  console.log(`  ${what}: ${detail}`);
};

console.log("\n--- tables, views and columns ---");
for (const table of new Set([...Object.keys(oldColumns), ...Object.keys(newColumns)])) {
  const before = oldColumns[table];
  const after = newColumns[table];
  if (!before) {
    report("only in the new backend", table);
    continue;
  }
  if (!after) {
    report("only in the old backend", table);
    continue;
  }
  for (const column of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[column] === undefined) report("column only in the new backend", `${table}.${column} = ${after[column]}`);
    else if (after[column] === undefined) report("column only in the old backend", `${table}.${column} = ${before[column]}`);
    else if (before[column] !== after[column]) {
      report(
        "column differs",
        `${table}.${column}\n      old: ${before[column]}\n      new: ${after[column]}`,
      );
    }
  }
}

console.log("\n--- RPCs ---");
for (const name of new Set([...Object.keys(oldRpcs), ...Object.keys(newRpcs)])) {
  const before = oldRpcs[name];
  const after = newRpcs[name];
  if (!before) {
    report("only in the new backend", name);
    continue;
  }
  if (!after) {
    report("only in the old backend", name);
    continue;
  }
  if (JSON.stringify(before.args) !== JSON.stringify(after.args)) {
    report(
      "arguments differ",
      `${name}\n      old: ${JSON.stringify(before.args)}\n      new: ${JSON.stringify(after.args)}`,
    );
  }
  if (before.required.join(",") !== after.required.join(",")) {
    report("required arguments differ", `${name}: old [${before.required}] new [${after.required}]`);
  }
}

if (differences === 0) {
  console.log(
    "\nIdentical table, column and RPC surface.\n" +
      "This does NOT cover RPC bodies, policy expressions or triggers - see the file header.",
  );
} else {
  console.log(`\n${differences} difference(s).`);
  process.exit(1);
}
