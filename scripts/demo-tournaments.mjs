/**
 * Seed, list or remove the sample tournaments Explore ships with.
 *
 * The two calls it makes are `public.seed_demo_tournaments()` and
 * `public.remove_demo_tournaments()`, defined in
 * `supabase/migrations/20261015010000_demo_tournament_seed.sql`. The generator lives in the
 * database rather than here for one reason that is worth restating: the SQL editor against a
 * hosted project, this script against a local stack and the integration suite all have to be
 * able to run *the same* generator, and a function is the only shape all three can call. This
 * script is the local and CI-friendly front door to it.
 *
 * ## Course of action
 *
 *   npm run demo:seed                  # against SUPABASE_URL / SERVICE_ROLE_KEY from the env
 *   npm run demo:seed -- --local       # against a stack started with `npx supabase start`
 *   npm run demo:remove                # the sample set, and nothing else
 *   npm run demo:list                  # what is there now, without changing anything
 *
 * `--yes` skips the confirmation prompt, for CI.
 *
 * ## Why it needs the service role, and why that is the point
 *
 * Both functions are revoked from `anon` and `authenticated`, so a signed-in user cannot call
 * them however they authenticate, and a leaked publishable key is not enough to litter a
 * shared project with sample data. The consequence is that this script holds a key that can
 * read and write everything, which is the same trade `backup-production.mjs` and
 * `reset-tournament-data.mjs` already make; it is why there is no default target, why the
 * target is printed before anything runs, and why seeding asks to be confirmed.
 *
 * ## Why it will seed a project that already has real tournaments
 *
 * It does not refuse. Demo rows are marked (`is_demo`) and reachable only through the two
 * calls above, so adding them to a live project is reversible with one command and cannot
 * touch a real row. Refusing would also be wrong on staging, which is meant to hold both.
 * What it does instead is *say so* - the confirmation lists how many real tournaments it can
 * see - so seeding production is a decision somebody made rather than a command that happened.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";

const VERBS = ["seed", "remove", "list"];

const args = process.argv.slice(2);
const verb = args.find((a) => !a.startsWith("-"));
const skipConfirm = args.includes("--yes") || args.includes("-y");
const local = args.includes("--local");

if (!verb || !VERBS.includes(verb)) {
  console.error(
    `Usage: node scripts/demo-tournaments.mjs <${VERBS.join("|")}> [--local] [--yes]\n\n` +
      "  seed    create or refresh the sample tournaments (idempotent)\n" +
      "  remove  delete every sample tournament and sample player, and nothing else\n" +
      "  list    report what is there now\n",
  );
  process.exit(2);
}

/**
 * The two credentials for the local stack, read from the CLI rather than from `.env`.
 *
 * `.env` names staging - `integration-target.mjs` refuses it for the same reason - and it
 * holds no service-role key at all, because a real one must never sit in a tracked file. The
 * local stack's keys are the CLI's public demo values, which is why reading them from
 * `supabase status` is safe and reading a hosted project's from a file is not.
 */
function localCredentials() {
  let output;
  try {
    output = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
  } catch (error) {
    console.error(
      `Could not read the local stack's credentials: ${error.message}\n` +
        "Start it first with `npx supabase start`.",
    );
    process.exit(1);
  }
  const read = (name) => output.match(new RegExp(`^${name}="([^"]+)"`, "m"))?.[1];
  const url = read("API_URL");
  const key = read("SERVICE_ROLE_KEY") ?? read("SECRET_KEY");
  if (!url || !key) {
    console.error("`supabase status -o env` did not report API_URL and SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  return { url, key, how: "the local stack" };
}

function environmentCredentials() {
  const url = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) {
    console.error(
      "Missing SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.\n" +
        "Set them for one run, or pass --local to use the stack `npx supabase start` is running.",
    );
    process.exit(2);
  }
  return { url, key, how: "the environment" };
}

const { url, key, how } = local ? localCredentials() : environmentCredentials();

// A service-role key is a JWT whose `role` claim is `service_role`; the newer `sb_secret_`
// keys carry the same authority without saying so in the payload. Refusing anything else by
// name is a cheap way to catch the publishable key being pasted in by mistake, which is the
// one mistake that would look like an authorization bug rather than a typo.
if (key.startsWith("sb_publishable_") || key.startsWith("eyJ")) {
  if (key.startsWith("sb_publishable_")) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is a publishable key. The sample calls are service-role only.");
    process.exit(2);
  }
  const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
  if (claims.role !== "service_role") {
    console.error(`SUPABASE_SERVICE_ROLE_KEY has role '${claims.role}', not 'service_role'.`);
    process.exit(2);
  }
}

const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** How much of the project is sample data, and how much of it is not. */
async function census() {
  const demo = await client
    .from("tournaments")
    .select("id", { count: "exact", head: true })
    .eq("is_demo", true);
  const real = await client
    .from("tournaments")
    .select("id", { count: "exact", head: true })
    .eq("is_demo", false);
  const players = await client
    .from("players")
    .select("id", { count: "exact", head: true })
    .eq("is_demo", true);
  for (const [name, result] of Object.entries({ demo, real, players })) {
    if (result.error) throw new Error(`Reading the ${name} count: ${result.error.message}`);
  }
  return {
    demo: demo.count ?? 0,
    real: real.count ?? 0,
    players: players.count ?? 0,
  };
}

async function confirm(action, detail) {
  if (skipConfirm) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nAbout to ${action} on ${url} (${how}):`);
    for (const line of detail) console.log(`  ${line}`);
    const answer = await rl.question(`\nType '${verb}' to continue: `);
    return answer.trim().toLowerCase() === verb;
  } finally {
    rl.close();
  }
}

/**
 * One call, and the whole thing is one transaction whether it succeeds or not: a failure half
 * way through the generator leaves the sample set exactly as it was.
 */
async function rpc(name) {
  const { data, error } = await client.rpc(name);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function main() {
  const before = await census();

  if (verb === "list") {
    if (!before.demo) {
      console.log(`No sample tournaments on ${url}. \`npm run demo:seed\` creates them.`);
      return;
    }
    const { data, error } = await client
      .from("tournaments")
      .select("name, status, starts_on, ends_on, venue_name")
      .eq("is_demo", true)
      .order("starts_on");
    if (error) throw new Error(error.message);
    console.log(`${before.demo} sample tournament(s) on ${url}:`);
    for (const row of data) {
      console.log(
        `  ${row.starts_on}  ${(row.status ?? "").padEnd(11)} ${row.name}  — ${row.venue_name}`,
      );
    }
    console.log(
      `\n${before.players} sample player(s). ` +
        `${before.real} real tournament(s) on this project are untouched by all of this.`,
    );
    return;
  }

  if (verb === "seed") {
    const ok = await confirm("replace the sample tournaments", [
      `${before.demo} sample tournament(s) and ${before.players} sample player(s) will be deleted and recreated from today's date`,
      before.real > 0
        ? `${before.real} REAL tournament(s) are on this project and will not be touched`
        : "no real tournaments on this project",
    ]);
    if (!ok) return console.log("Aborted — nothing was written.");

    const rows = await rpc("seed_demo_tournaments");
    console.log(`\nSeeded ${rows.length} sample tournaments on ${url}:\n`);
    const width = Math.max(...rows.map((r) => r.tournament.length), 4);
    for (const row of rows) {
      console.log(
        `  ${row.tournament.padEnd(width)}  ${row.status.padEnd(11)} ` +
          `${String(row.entries).padStart(3)} entries  ${String(row.events)} events  ${row.dates}  ${row.stage}`,
      );
    }
    const after = await census();
    console.log(
      `\n${after.demo} sample tournament(s) and ${after.players} sample player(s). ` +
        `Dates are relative to today, so re-running this is also how the set is refreshed.`,
    );
    return;
  }

  // remove
  if (!before.demo && !before.players) {
    console.log(`Nothing to remove on ${url} — there is no sample data here.`);
    return;
  }
  const ok = await confirm("remove the sample tournaments", [
    `${before.demo} sample tournament(s) and ${before.players} sample player(s) will be deleted`,
    before.real > 0
      ? `${before.real} REAL tournament(s) are on this project and will not be touched`
      : "no real tournaments on this project",
  ]);
  if (!ok) return console.log("Aborted — nothing was deleted.");

  const removed = await rpc("remove_demo_tournaments");
  const after = await census();
  console.log(
    `\nRemoved ${removed} sample tournament(s) and ${before.players - after.players} sample player(s).`,
  );
  console.log(
    after.real > 0
      ? `${after.real} real tournament(s) remain, exactly as they were.`
      : "This project now has no tournaments at all.",
  );
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
