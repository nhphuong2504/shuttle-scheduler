/**
 * Wipe the desk back to a blank slate so a tournament can be created from scratch.
 *
 * Removes every result (pool + knockout), every entry, every player, and the
 * tournament itself with its days, courts and categories. `profiles` is kept so
 * nobody loses their login or its platform role. Safe to re-run.
 *
 * Usage (pick one auth method):
 *   SUPABASE_SERVICE_ROLE_KEY=sb_secret_... node scripts/reset-tournament-data.mjs --yes
 *   SUPABASE_ACCESS_TOKEN=eyJ... node scripts/reset-tournament-data.mjs --yes
 *   SUPABASE_DESK_EMAIL=... SUPABASE_DESK_PASSWORD=... node scripts/reset-tournament-data.mjs --yes
 *
 * Flags:
 *   --yes                skip the confirmation prompt
 *   --keep-tournament    keep the tournament, its days, courts and categories,
 *                        and only clear results / entries / players
 *
 * The equivalent SQL is in scripts/reset-tournament-data.sql for the Supabase
 * SQL editor (which needs no credentials at all).
 */
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const publishable =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const deskEmail = process.env.SUPABASE_DESK_EMAIL;
const deskPassword = process.env.SUPABASE_DESK_PASSWORD;

/**
 * There is deliberately no default target.
 *
 * This script deletes data, so the project it points at must be stated, never
 * inferred from a fallback that a future reader cannot see. It previously defaulted
 * to a hardcoded Lovable Cloud project URL and publishable key, which meant an
 * operator with no environment configured would silently run against that project.
 */
if (!url || !publishable) {
  console.error(
    "Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY (or their VITE_ twins).\n" +
      "Set them in .env, or export them for one run, before running this script.",
  );
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const skipConfirm = args.has("--yes") || args.has("-y");
const keepTournament = args.has("--keep-tournament");

/**
 * Leaf-first. Every foreign key in this schema is ON DELETE CASCADE or
 * SET NULL, so this order is not strictly required — but doing it explicitly
 * keeps the run reportable and makes a failure easy to reason about.
 */
const RESULT_TABLES = [
  "desk_activity",
  "draw_matches",
  "draws",
  "pool_matches",
  "pool_entries",
  "pools",
];

const ENTRY_TABLES = ["teams", "players"];

/** Only cleared when the whole tournament is being removed. */
const STRUCTURE_TABLES = ["categories", "courts", "tournament_days", "tournaments"];

const CONFIRM_TABLES = keepTournament
  ? [...RESULT_TABLES, ...ENTRY_TABLES]
  : [...RESULT_TABLES, ...ENTRY_TABLES, ...STRUCTURE_TABLES];

async function createAuthClient() {
  if (serviceRole) {
    return createClient(url, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  const client = createClient(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (accessToken) {
    const { error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: accessToken,
    });
    if (error) throw new Error(`Invalid SUPABASE_ACCESS_TOKEN: ${error.message}`);
    return client;
  }

  if (deskEmail && deskPassword) {
    const { error } = await client.auth.signInWithPassword({
      email: deskEmail,
      password: deskPassword,
    });
    if (error) throw new Error(`Desk sign-in failed: ${error.message}`);
    return client;
  }

  throw new Error(
    "Missing credentials. Set SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN, or SUPABASE_DESK_EMAIL + SUPABASE_DESK_PASSWORD.",
  );
}

async function countOf(client, table) {
  const { count, error } = await client.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

/**
 * PostgREST refuses an unfiltered DELETE, so filter on the primary key being
 * non-null (always true). `.select()` returns the removed rows, which gives an
 * exact deleted count including cascaded children.
 */
async function clear(client, table) {
  const { data, error } = await client.from(table).delete().not("id", "is", null).select("id");
  if (error) throw new Error(`${table}: ${error.message}`);
  return data?.length ?? 0;
}

async function confirm(client) {
  if (skipConfirm) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nAbout to permanently delete from ${url}:`);
    for (const table of CONFIRM_TABLES) {
      const count = await countOf(client, table).catch(() => "?");
      console.log(`  ${table.padEnd(16)} ${count} row(s)`);
    }
    console.log(
      keepTournament
        ? "\nprofiles and the tournament structure are kept."
        : "\nprofiles is kept; everything else goes.",
    );
    const answer = await rl.question("\nType 'reset' to continue: ");
    return answer.trim().toLowerCase() === "reset";
  } finally {
    rl.close();
  }
}

async function main() {
  const client = await createAuthClient();
  const mode = serviceRole ? "service role" : accessToken ? "access token" : "desk sign-in";
  console.log(`Resetting ${url} using ${mode}${keepTournament ? " (keeping tournament)" : ""}.`);

  if (!(await confirm(client))) {
    console.log("Aborted — nothing was deleted.");
    return;
  }

  let removed = 0;
  for (const table of CONFIRM_TABLES) {
    const count = await clear(client, table);
    removed += count;
    console.log(`  ${table.padEnd(16)} deleted ${count}`);
  }

  console.log(`\nDeleted ${removed} row(s). profiles was left untouched.`);

  const leftovers = [];
  for (const table of CONFIRM_TABLES) {
    const count = await countOf(client, table).catch(() => 0);
    if (count) leftovers.push(`${table}=${count}`);
  }
  console.log(
    leftovers.length
      ? `Still non-empty: ${leftovers.join(", ")} — check RLS on those tables.`
      : "Every cleared table is now empty. Create the new tournament from /setup.",
  );

  if (!keepTournament) {
    console.log(
      "\nOptional: restart the desk_activity id counter by running this once in the SQL editor:",
    );
    console.log("  ALTER TABLE public.desk_activity ALTER COLUMN id RESTART WITH 1;");
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
