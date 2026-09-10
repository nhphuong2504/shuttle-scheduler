/**
 * Mark every incomplete pool match as reported with synthetic 21-x scores.
 *
 * Usage (pick one auth method):
 *   SUPABASE_SERVICE_ROLE_KEY=sb_secret_... node scripts/fake-day-one-results.mjs
 *   SUPABASE_ACCESS_TOKEN=eyJ... node scripts/fake-day-one-results.mjs
 *   SUPABASE_DESK_EMAIL=... SUPABASE_DESK_PASSWORD=... node scripts/fake-day-one-results.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url =
  process.env.SUPABASE_URL ??
  process.env.VITE_SUPABASE_URL ??
  "https://hdmfxndanyrbxedgboev.supabase.co";
const publishable =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_6A1AhD2WpHIKfFlj7gsz-g_9WDaZUso";
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const deskEmail = process.env.SUPABASE_DESK_EMAIL;
const deskPassword = process.env.SUPABASE_DESK_PASSWORD;

function loserScore(id) {
  return 10 + (Math.abs(hashCode(id)) % 8);
}

function hashCode(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function fakeScores(match) {
  const aWins = Math.abs(hashCode(match.id)) % 2 === 0;
  const loser = loserScore(match.id);
  return {
    scoreA: aWins ? 21 : loser,
    scoreB: aWins ? loser : 21,
    winnerId: aWins ? match.team_a_id : match.team_b_id,
  };
}

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

async function runWithServiceRole(client) {
  const { data: matches, error: loadError } = await client
    .from("pool_matches")
    .select("id, team_a_id, team_b_id, scheduled_time, status")
    .not("status", "in", '("reported","walkover","void")');
  if (loadError) throw loadError;

  const slotMinutes = 20;
  for (const match of matches ?? []) {
    const { scoreA, scoreB, winnerId } = fakeScores(match);
    const ended = match.scheduled_time
      ? new Date(new Date(match.scheduled_time).getTime() + slotMinutes * 60_000).toISOString()
      : new Date().toISOString();
    const { error: updateError } = await client
      .from("pool_matches")
      .update({
        score_a: scoreA,
        score_b: scoreB,
        winner_id: winnerId,
        status: "reported",
        started_at: match.scheduled_time ?? ended,
        ended_at: ended,
        reported_time: ended,
      })
      .eq("id", match.id);
    if (updateError) throw updateError;
  }

  await client.from("courts").update({ status: "free" }).neq("status", "free");
  return matches?.length ?? 0;
}

async function runWithRpc(client) {
  const { data: matches, error: loadError } = await client
    .from("pool_matches")
    .select("id, team_a_id, team_b_id, status")
    .not("status", "in", '("reported","walkover","void")');
  if (loadError) throw loadError;

  let done = 0;
  for (const match of matches ?? []) {
    const { scoreA, scoreB } = fakeScores(match);
    const { error } = await client.rpc("report_pool_result", {
      p_match_id: match.id,
      p_score_a: scoreA,
      p_score_b: scoreB,
    });
    if (error) throw new Error(`${match.id}: ${error.message}`);
    done++;
    if (done % 25 === 0) process.stdout.write(`  reported ${done}/${matches.length}\n`);
  }
  return done;
}

async function main() {
  const client = await createAuthClient();
  const mode = serviceRole ? "service-role bulk update" : "report_pool_result RPC";
  console.log(`Using ${mode} against ${url}`);

  const count = serviceRole ? await runWithServiceRole(client) : await runWithRpc(client);
  console.log(`Reported ${count} pool matches.`);

  const { count: remaining } = await client
    .from("pool_matches")
    .select("*", { count: "exact", head: true })
    .not("status", "in", '("reported","walkover","void")');
  console.log(`Remaining incomplete pool matches: ${remaining ?? "?"}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
