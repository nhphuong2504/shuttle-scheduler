#!/usr/bin/env node
// Exports a point-in-time snapshot of Aloha (2026-10-26/27) from the staging project.
//
// This script is read-only: every statement it sends is a SELECT, and it never writes back
// to Supabase. Aloha is still in progress, so re-running it later captures a later state;
// the transformation below is kept here so every re-export derives first_published_time,
// drift and the attached flag the same way.
//
// Usage:
//   node analysis/aloha-2026/export.mjs
//
// Credentials: SUPABASE_ACCESS_TOKEN from the environment, falling back to the repository
// .env. The token is never printed and never written to an output file. Player email, phone
// and profile_id, organiser contact fields and the owner profile id are deliberately dropped
// on the way out.
//
// Output: this directory's CSVs, tournament.json and summary.json. README.md is prose and is
// not generated - update it by hand when the numbers change.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const PROJECT_REF = "dzilzdxzdrrbdimhbiwv"; // staging; never point this at production
const TOURNAMENT_ID = "424c17ad-13c4-4c99-83e3-845b4a4bf992";
// Set from tournaments.venue_timezone after the first fetch; every row in this tournament
// is stored in UTC and only the rendered local time depends on this.
let VENUE_TZ = "America/Chicago";

// ---------------------------------------------------------------------------------------------
// Transport

function accessToken() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const env = readFileSync(join(REPO, ".env"), "utf8");
  const token = env.match(/^\s*SUPABASE_ACCESS_TOKEN\s*=\s*"?([^"\n]+)"?\s*$/m)?.[1]?.trim();
  if (!token) {
    throw new Error("No SUPABASE_ACCESS_TOKEN in the environment or repository .env.");
  }
  return token;
}

const token = accessToken();

async function sql(query) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase query failed: ${text.trim()}`);
  }
  return JSON.parse(text);
}

async function table(name, select, where, order) {
  const query =
    `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text as rows ` +
    `from (select ${select} from ${name} where ${where} order by ${order}) t`;
  return JSON.parse((await sql(query))[0].rows);
}

// ---------------------------------------------------------------------------------------------
// Raw export. Field lists mirror the database; personal data is excluded by naming columns.

const tid = `'${TOURNAMENT_ID}'`;

const tournament = (
  await table(
    "tournaments",
    [
      "id",
      "name",
      "rest_gap_minutes",
      "group_slot_minutes",
      "knockout_slot_minutes",
      "court_count",
      "created_at",
      "group_rest_gap_minutes",
      "knockout_rest_gap_minutes",
      "venue_timezone",
      "day_count",
      "status",
      "format",
      "venue_name",
      "venue_address",
      "organizer_name",
      "max_categories_per_player",
      "placement_games_to",
      "placement_win_by",
      "placement_best_of",
      "knockout_games_to",
      "knockout_win_by",
      "knockout_best_of",
      "notes",
      "registration_opens_at",
      "registration_closes_at",
      "starts_on",
      "ends_on",
      "block_start_on_short_rest",
      "is_demo",
    ].join(","),
    `id = ${tid}`,
    "id",
  )
)[0];

VENUE_TZ = tournament.venue_timezone ?? VENUE_TZ;

const days = await table("tournament_days", "*", `tournament_id = ${tid}`, "day_number");
const dayCourts = await table(
  "tournament_day_courts",
  "*",
  `tournament_id = ${tid}`,
  "day_id,court_id",
);
const dayBreaks = await table(
  "tournament_day_breaks",
  "*",
  `tournament_id = ${tid}`,
  "day_id,start_time",
);
const courts = await table("courts", "*", `tournament_id = ${tid}`, "number");
const categories = await table("categories", "*", `tournament_id = ${tid}`, "sort_order");
const teams = await table("teams", "*", `tournament_id = ${tid}`, "category_id,created_at,id");
const players = await table(
  "players",
  "id,name,gender,is_demo,created_at",
  `id in (
     select player_1_id from teams where tournament_id = ${tid}
     union
     select player_2_id from teams where tournament_id = ${tid}
   )`,
  "name",
);
const entrants = await table(
  "placement_entrants",
  "*",
  `tournament_id = ${tid}`,
  "category_id,seed nulls last,id",
);
const matches = await table(
  "placement_matches",
  "*",
  `tournament_id = ${tid}`,
  "category_id,stage,generation_key",
);
const roundTwoSlots = await table(
  "placement_round_two_slots",
  "*",
  `category_id in (select id from categories where tournament_id = ${tid})`,
  "category_id,generation_key",
);
const tierDraws = await table("tier_draws", "*", `tournament_id = ${tid}`, "category_id,tier");
const tierDrawMatches = await table(
  "tier_draw_matches",
  "*",
  `tournament_id = ${tid}`,
  "draw_id,round,slot",
);
const pools = await table("pools", "*", `tournament_id = ${tid}`, "id");
const poolMatches = await table("pool_matches", "*", `tournament_id = ${tid}`, "id");
const registrations = await table(
  "tournament_registrations",
  "id,tournament_id,status,created_at,updated_at",
  `tournament_id = ${tid}`,
  "id",
);

const playDates = days.map((day) => day.date);
const playDateList = playDates.map((date) => `'${date}'::date`).join(", ");

const matchResultHistory = await table(
  "match_result_history",
  "*",
  `match_id in (
     select id from placement_matches where tournament_id = ${tid}
     union
     select id from tier_draw_matches where tournament_id = ${tid}
   )`,
  "changed_at",
);

// Activity is scoped by the days actually played, not by the matches that still exist: the
// trail deliberately keeps rows for matches an abandoned build deleted (attached = false).
const deskActivity = await table(
  "desk_activity",
  "*",
  `(occurred_at at time zone '${VENUE_TZ}')::date in (${playDateList})`,
  "occurred_at,id",
);

// ---------------------------------------------------------------------------------------------
// Lookups and formatting helpers

const categoryById = new Map(categories.map((category) => [category.id, category]));
const categoryOrder = new Map(categories.map((category, index) => [category.id, index]));
const courtNumber = new Map(courts.map((court) => [court.id, court.number]));
const teamById = new Map(teams.map((team) => [team.id, team]));
const playerName = new Map(players.map((player) => [player.id, player.name]));
const entrantById = new Map(entrants.map((entrant) => [entrant.id, entrant]));
const drawById = new Map(tierDraws.map((draw) => [draw.id, draw]));
const placementByKey = new Map(
  matches.map((match) => [`${match.category_id}:${match.generation_key}`, match]),
);
const matchById = new Map([...matches, ...tierDrawMatches].map((match) => [match.id, match]));

const minutesBetween = (from, to) => (new Date(to) - new Date(from)) / 60_000;
const round1 = (value) => Math.round(value * 10) / 10;
const localDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: VENUE_TZ });
const localDateTime = (iso) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: VENUE_TZ, hour12: false }).replace("T", " ");
const localClock = (iso) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: VENUE_TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function teamLabel(team) {
  if (!team) return "";
  const first = playerName.get(team.player_1_id) ?? "";
  const second = team.player_2_id ? playerName.get(team.player_2_id) : null;
  return second ? `${first} / ${second}` : first;
}

function entrantLabel(entrantId) {
  const entrant = entrantById.get(entrantId);
  return entrant ? teamLabel(teamById.get(entrant.team_id)) : "";
}

function categoryCode(categoryId) {
  return categoryById.get(categoryId)?.code ?? categoryId;
}

function placementLabel(match) {
  return `${categoryCode(match.category_id)} ${match.stage} ${match.generation_key}`;
}

function drawLabel(match) {
  const draw = drawById.get(match.draw_id);
  if (!draw) return match.id;
  return `${categoryCode(draw.category_id)} draw ${draw.tier} r${match.round} s${match.slot}`;
}

function matchLabel(matchId) {
  const match = matchById.get(matchId);
  if (!match) return "(match no longer exists)";
  return match.draw_id ? drawLabel(match) : placementLabel(match);
}

// first_published_time is the earliest time the activity trail ever held for the match. It is
// recovered, not stored: scheduled_time is the current published time and may already have been
// pushed by the live reflow.
const firstPublished = new Map();
for (const row of deskActivity) {
  const toTime = row.details?.to_time;
  if (!toTime) continue;
  const current = firstPublished.get(row.match_id);
  if (!current || new Date(toTime) < new Date(current)) {
    firstPublished.set(row.match_id, toTime);
  }
}

const attached = new Set(matchById.keys());

function drift(match) {
  if (!match.scheduled_time) return null;
  const first = firstPublished.get(match.id);
  if (!first) return null;
  return round1(minutesBetween(first, match.scheduled_time));
}

function startDelay(match) {
  if (!match.scheduled_time || !match.started_at) return null;
  return round1(minutesBetween(match.scheduled_time, match.started_at));
}

function duration(match) {
  if (!match.started_at || !match.ended_at) return null;
  return round1(minutesBetween(match.started_at, match.ended_at));
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") value = JSON.stringify(value);
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function toCsv(columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvValue(row[column])).join(","));
  return "\uFEFF" + lines.join("\n") + "\n";
}

function writeCsv(name, columns, rows) {
  writeFileSync(join(HERE, name), toCsv(columns, rows));
}

function naturalKey(key) {
  const rank = { round1: 0, round2: 1 };
  const match = /^r(\d+)-(.+)$/.exec(key);
  if (!match) return key;
  const stage = Number(match[1]);
  const tail = match[2];
  const makeup = tail.startsWith("makeup-") ? 1 : 0;
  const number = Number(tail.replace("makeup-", ""));
  return `${String(stage).padStart(2, "0")}-${String(makeup)}-${String(number).padStart(3, "0")}`;
}

matches.sort(
  (a, b) =>
    categoryOrder.get(a.category_id) - categoryOrder.get(b.category_id) ||
    naturalKey(a.generation_key).localeCompare(naturalKey(b.generation_key)),
);

tierDraws.sort(
  (a, b) =>
    categoryOrder.get(a.category_id) - categoryOrder.get(b.category_id) ||
    a.tier.localeCompare(b.tier),
);

tierDrawMatches.sort((a, b) => {
  const left = drawById.get(a.draw_id);
  const right = drawById.get(b.draw_id);
  return (
    categoryOrder.get(left.category_id) - categoryOrder.get(right.category_id) ||
    left.tier.localeCompare(right.tier) ||
    a.round - b.round ||
    a.slot - b.slot
  );
});

// ---------------------------------------------------------------------------------------------
// Derived match rows

const placementRows = matches.map((match) => {
  const first = firstPublished.get(match.id) ?? null;
  const durationMin = duration(match);
  const slot = tournament.group_slot_minutes;
  return {
    match_id: match.id,
    category: categoryCode(match.category_id),
    stage: match.stage,
    generation_key: match.generation_key,
    status: match.status,
    court_number: courtNumber.get(match.court_id) ?? "",
    scheduled_time: match.scheduled_time ?? "",
    first_published_time: first ?? "",
    started_at: match.started_at ?? "",
    ended_at: match.ended_at ?? "",
    reported_time: match.reported_time ?? "",
    published_start_delay_min: startDelay(match) ?? "",
    drift_from_first_publish_min: drift(match) ?? "",
    actual_duration_min: durationMin ?? "",
    slot_minutes: slot,
    overrun_min: durationMin === null ? "" : round1(durationMin - slot),
    side_a: entrantLabel(match.entrant_a_id),
    side_b: entrantLabel(match.entrant_b_id),
    winner_side:
      match.winner_id === match.entrant_a_id
        ? "A"
        : match.winner_id === match.entrant_b_id
          ? "B"
          : "",
    games: match.games ?? [],
    is_makeup: match.is_makeup,
    is_crossover: match.is_crossover,
    prerequisite_count: match.prerequisite_ids?.length ?? 0,
    prerequisite_keys: (match.prerequisite_ids ?? [])
      .map((id) => {
        const prerequisite = matchById.get(id);
        return prerequisite?.generation_key ?? id;
      })
      .join(" "),
    note: match.note ?? "",
  };
});

const drawRows = tierDrawMatches.map((match) => {
  const draw = drawById.get(match.draw_id);
  const first = firstPublished.get(match.id) ?? null;
  const durationMin = duration(match);
  const slot = tournament.knockout_slot_minutes;
  return {
    match_id: match.id,
    category: categoryCode(draw.category_id),
    draw: draw.tier,
    round: match.round,
    slot: match.slot,
    status: match.status,
    is_bye: match.status === "bye",
    court_number: courtNumber.get(match.court_id) ?? "",
    scheduled_time: match.scheduled_time ?? "",
    first_published_time: first ?? "",
    started_at: match.started_at ?? "",
    ended_at: match.ended_at ?? "",
    reported_time: match.reported_time ?? "",
    published_start_delay_min: startDelay(match) ?? "",
    drift_from_first_publish_min: drift(match) ?? "",
    actual_duration_min: durationMin ?? "",
    slot_minutes: slot,
    overrun_min: durationMin === null ? "" : round1(durationMin - slot),
    side_a: entrantLabel(match.entrant_a_id),
    side_b: entrantLabel(match.entrant_b_id),
    winner_side:
      match.winner_id === match.entrant_a_id
        ? "A"
        : match.winner_id === match.entrant_b_id
          ? "B"
          : "",
    games: match.games ?? [],
    note: match.note ?? "",
  };
});

const activityRows = deskActivity.map((row) => ({
  id: row.id,
  occurred_at_utc: row.occurred_at,
  occurred_at_local: localDateTime(row.occurred_at),
  action: row.action,
  match_table: row.match_table ?? "",
  match_id: row.match_id ?? "",
  match_label: matchLabel(row.match_id),
  attached: attached.has(row.match_id),
  from_status: row.details?.from_status ?? "",
  to_status: row.details?.to_status ?? "",
  from_time: row.details?.from_time ?? "",
  to_time: row.details?.to_time ?? "",
  from_court: courtNumber.get(row.details?.from_court_id) ?? "",
  to_court: courtNumber.get(row.details?.to_court_id) ?? "",
  actor_id: row.actor_id ?? "",
  details_json: row.details ?? {},
}));

// ---------------------------------------------------------------------------------------------
// CSV files

writeCsv(
  "categories.csv",
  ["category_id", "code", "name", "gender", "entry_type", "sort_order", "active"],
  categories.map((category) => ({
    category_id: category.id,
    code: category.code,
    name: category.name,
    gender: category.gender,
    entry_type: category.entry_type,
    sort_order: category.sort_order,
    active: category.active,
  })),
);

writeCsv(
  "courts.csv",
  ["court_id", "number", "status"],
  courts.map((court) => ({
    court_id: court.id,
    number: court.number,
    status: court.status,
  })),
);

writeCsv(
  "days.csv",
  ["day_number", "date", "start_time", "end_time"],
  days.map((day) => ({
    day_number: day.day_number,
    date: day.date,
    start_time: day.start_time,
    end_time: day.end_time,
  })),
);

writeCsv(
  "players.csv",
  ["player_id", "name", "gender", "is_demo", "created_at"],
  players.map((player) => ({
    player_id: player.id,
    name: player.name,
    gender: player.gender,
    is_demo: player.is_demo,
    created_at: player.created_at,
  })),
);

writeCsv(
  "teams.csv",
  ["team_id", "category", "seed", "withdrawn", "player_1", "player_2", "label"],
  teams
    .slice()
    .sort(
      (a, b) =>
        categoryOrder.get(a.category_id) - categoryOrder.get(b.category_id) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    )
    .map((team) => ({
      team_id: team.id,
      category: categoryCode(team.category_id),
      seed: team.seed ?? "",
      withdrawn: team.withdrawn,
      player_1: playerName.get(team.player_1_id) ?? "",
      player_2: playerName.get(team.player_2_id) ?? "",
      label: teamLabel(team),
    })),
);

writeCsv(
  "entrants.csv",
  ["entrant_id", "category", "seed", "seed_locked_at", "tier", "excluded", "skill_level", "team"],
  entrants
    .slice()
    .sort(
      (a, b) =>
        categoryOrder.get(a.category_id) - categoryOrder.get(b.category_id) ||
        (a.seed ?? 9999) - (b.seed ?? 9999) ||
        a.id.localeCompare(b.id),
    )
    .map((entrant) => ({
      entrant_id: entrant.id,
      category: categoryCode(entrant.category_id),
      seed: entrant.seed ?? "",
      seed_locked_at: entrant.seed_locked_at ?? "",
      tier: entrant.tier ?? "",
      excluded: entrant.excluded,
      skill_level: entrant.skill_level ?? "",
      team: teamLabel(teamById.get(entrant.team_id)),
    })),
);

const matchColumns = [
  "match_id",
  "category",
  "stage",
  "generation_key",
  "status",
  "court_number",
  "scheduled_time",
  "first_published_time",
  "started_at",
  "ended_at",
  "reported_time",
  "published_start_delay_min",
  "drift_from_first_publish_min",
  "actual_duration_min",
  "slot_minutes",
  "overrun_min",
  "side_a",
  "side_b",
  "winner_side",
  "games",
  "is_makeup",
  "is_crossover",
  "prerequisite_count",
  "prerequisite_keys",
  "note",
];
writeCsv("matches.csv", matchColumns, placementRows);

const drawColumns = [
  "match_id",
  "category",
  "draw",
  "round",
  "slot",
  "status",
  "is_bye",
  "court_number",
  "scheduled_time",
  "first_published_time",
  "started_at",
  "ended_at",
  "reported_time",
  "published_start_delay_min",
  "drift_from_first_publish_min",
  "actual_duration_min",
  "slot_minutes",
  "overrun_min",
  "side_a",
  "side_b",
  "winner_side",
  "games",
  "note",
];
writeCsv("draw-matches.csv", drawColumns, drawRows);

writeCsv(
  "desk-activity.csv",
  [
    "id",
    "occurred_at_utc",
    "occurred_at_local",
    "action",
    "match_table",
    "match_id",
    "match_label",
    "attached",
    "from_status",
    "to_status",
    "from_time",
    "to_time",
    "from_court",
    "to_court",
    "actor_id",
    "details_json",
  ],
  activityRows,
);

// ---------------------------------------------------------------------------------------------
// tournament.json: the same tables, raw, with derived `attached` on the activity trail.

const tournamentJson = {
  exportedAt: new Date().toISOString(),
  project: PROJECT_REF,
  tournament,
  days,
  day_courts: dayCourts,
  day_breaks: dayBreaks,
  courts,
  categories,
  teams,
  players,
  entrants,
  matches,
  round_two_slots: roundTwoSlots,
  tier_draws: tierDraws,
  tier_draw_matches: tierDrawMatches,
  pools,
  pool_matches: poolMatches,
  registrations,
  editors: [],
  match_result_history: matchResultHistory.map((row) => {
    const copy = { ...row };
    delete copy.changed_by;
    return copy;
  }),
  desk_activity: deskActivity.map((row) => ({
    ...row,
    attached: attached.has(row.match_id),
  })),
};
writeFileSync(join(HERE, "tournament.json"), JSON.stringify(tournamentJson, null, 2) + "\n");

// ---------------------------------------------------------------------------------------------
// summary.json

function stats(values) {
  if (!values.length) return { n: 0, meanMin: null, medianMin: null, minMin: null, maxMin: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    n: sorted.length,
    meanMin: round1(mean),
    medianMin: round1(sorted[Math.floor(sorted.length / 2)]),
    minMin: round1(sorted[0]),
    maxMin: round1(sorted.at(-1)),
  };
}

function stageStats(played, slotMinutes, spillIds = new Set()) {
  const durations = played.map((match) => duration(match));
  const overruns = durations.map((value) => value - slotMinutes);
  const overSlots = overruns.filter((value) => value > 0);
  const delays = played.map(startDelay).filter((value) => value !== null);
  const drifts = played.map(drift).filter((value) => value !== null);
  const movedDrifts = drifts.filter((value) => value > 0.05);
  const intraDayDrifts = played
    .filter((match) => !spillIds.has(match.id))
    .map(drift)
    .filter((value) => value !== null);
  const movedIntraDay = intraDayDrifts.filter((value) => value > 0.05);
  return {
    slotMinutes,
    duration: stats(durations),
    overrun: {
      matches: overSlots.length,
      share: round1((overSlots.length / durations.length) * 100) / 100,
      meanMin: round1(overSlots.reduce((sum, value) => sum + value, 0) / overSlots.length),
      meanAllMin: round1(overruns.reduce((sum, value) => sum + value, 0) / overruns.length),
      maxMin: round1(Math.max(...overruns)),
    },
    startDelay: stats(delays),
    drift: {
      ...stats(drifts),
      moved: movedDrifts.length,
      movedMeanMin: round1(movedDrifts.reduce((sum, value) => sum + value, 0) / movedDrifts.length),
      intraDay: {
        ...stats(intraDayDrifts),
        moved: movedIntraDay.length,
        movedMeanMin: round1(
          movedIntraDay.reduce((sum, value) => sum + value, 0) / movedIntraDay.length,
        ),
      },
    },
  };
}

const placementPlayed = matches.filter((match) => match.started_at && match.ended_at);
const drawPlayed = tierDrawMatches.filter((match) => match.started_at && match.ended_at);
const allPlayed = [...placementPlayed, ...drawPlayed];

// A match whose first published time was on an earlier local day was carried across the day
// boundary. Its drift is a planning decision, not intra-day reflow, and is reported separately.
const spill = placementPlayed.filter((match) => {
  const first = firstPublished.get(match.id);
  return first && localDate(first) !== localDate(match.scheduled_time);
});
const spillIds = new Set(spill.map((match) => match.id));

const daysSummary = days.map((day) => {
  const onDay = allPlayed.filter((match) => localDate(match.started_at) === day.date);
  const placementOnDay = onDay.filter((match) => !match.draw_id);
  const drawOnDay = onDay.filter((match) => match.draw_id);
  const courtMinutes = onDay.reduce((sum, match) => sum + duration(match), 0);
  const [startHour, startMinute] = day.start_time.split(":").map(Number);
  const [endHour, endMinute] = day.end_time.split(":").map(Number);
  const windowMinutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  const capacity = windowMinutes * courts.length;
  const firstStart = onDay.map((match) => match.started_at).sort()[0];
  const lastEnd = onDay
    .map((match) => match.ended_at)
    .sort()
    .at(-1);
  const activeMinutes = minutesBetween(firstStart, lastEnd);
  return {
    date: day.date,
    windowLocal: `${day.start_time.slice(0, 5)}–${day.end_time.slice(0, 5)}`,
    courts: courts.length,
    matchesStarted: onDay.length,
    byStage: {
      placement: placementOnDay.length,
      knockout: drawOnDay.length,
    },
    firstStartLocal: localClock(firstStart),
    lastStartLocal: localClock(
      onDay
        .map((match) => match.started_at)
        .sort()
        .at(-1),
    ),
    lastEndLocal: localClock(lastEnd),
    courtMinutes: round1(courtMinutes),
    courtCapacityMinutes: capacity,
    utilization: round1((courtMinutes / capacity) * 1000) / 1000,
    activeMinutes: round1(activeMinutes),
    activeUtilization: round1((courtMinutes / (activeMinutes * courts.length)) * 1000) / 1000,
  };
});

const totalCourtMinutes = allPlayed.reduce((sum, match) => sum + duration(match), 0);
const totalCapacity = daysSummary.reduce((sum, day) => sum + day.courtCapacityMinutes, 0);

const perCategory = categories.map((category) => {
  const categoryMatches = matches.filter((match) => match.category_id === category.id);
  const categoryDraws = tierDraws.filter((draw) => draw.category_id === category.id);
  const drawMatches = tierDrawMatches.filter((match) =>
    categoryDraws.some((draw) => draw.id === match.draw_id),
  );
  return {
    category: category.code,
    entryType: category.entry_type,
    entrants: entrants.filter((entrant) => entrant.category_id === category.id).length,
    placement: {
      matches: categoryMatches.length,
      reported: categoryMatches.filter((match) => match.status === "reported").length,
      round1: categoryMatches.filter((match) => match.stage === "round1").length,
      round2: categoryMatches.filter((match) => match.stage === "round2").length,
      makeups: categoryMatches.filter((match) => match.is_makeup).length,
      crossovers: categoryMatches.filter((match) => match.is_crossover).length,
    },
    knockout: {
      draws: categoryDraws.length,
      matches: drawMatches.length,
      played: drawMatches.filter((match) => match.status === "reported").length,
      byes: drawMatches.filter((match) => match.status === "bye").length,
      tiers: categoryDraws.map((draw) => {
        const bracketMatches = tierDrawMatches.filter((match) => match.draw_id === draw.id);
        const champion = entrantById.get(draw.champion_id);
        const final = bracketMatches
          .filter((match) => match.status === "reported")
          .sort((a, b) => b.round - a.round || b.slot - a.slot)[0];
        return {
          tier: draw.tier,
          bracketSize: draw.bracket_size,
          entrants: draw.entrant_count,
          matches: bracketMatches.length,
          played: bracketMatches.filter((match) => match.status === "reported").length,
          byes: bracketMatches.filter((match) => match.status === "bye").length,
          champion: champion ? teamLabel(teamById.get(champion.team_id)) : null,
          final: final
            ? {
                sideA: entrantLabel(final.entrant_a_id),
                sideB: entrantLabel(final.entrant_b_id),
                winnerSide:
                  final.winner_id === final.entrant_a_id
                    ? "A"
                    : final.winner_id === final.entrant_b_id
                      ? "B"
                      : "",
                games: final.games ?? [],
              }
            : null,
          decidedWithoutAMatch: bracketMatches.every((match) => match.status === "bye"),
        };
      }),
    },
  };
});

const carried = spill
  .map((match) => ({
    match: placementLabel(match),
    firstPublishedLocal: localDateTime(firstPublished.get(match.id)),
    playedLocal: localDateTime(match.started_at),
    driftMin: drift(match),
  }))
  .sort((a, b) => (b.driftMin ?? 0) - (a.driftMin ?? 0));

const activityByAction = activityRows.reduce((result, row) => {
  result[row.action] = (result[row.action] ?? 0) + 1;
  return result;
}, {});
const activityByTable = activityRows.reduce((result, row) => {
  result[row.match_table] = (result[row.match_table] ?? 0) + 1;
  return result;
}, {});
const activityByDate = activityRows.reduce((result, row) => {
  const date = row.occurred_at_local.slice(0, 10);
  result[date] = (result[date] ?? 0) + 1;
  return result;
}, {});

const nightMatches = allPlayed.filter(
  (match) => localDate(match.started_at) !== localDate(match.ended_at),
);

// Rest is per player, not per team: in doubles all four players are checked. Turnarounds that
// cross midnight are excluded because the next day's window, not the rest rule, sets the gap.
const restGaps = (() => {
  const perPlayer = new Map();
  for (const match of allPlayed) {
    for (const entrantId of [match.entrant_a_id, match.entrant_b_id].filter(Boolean)) {
      const entrant = entrantById.get(entrantId);
      const team = entrant ? teamById.get(entrant.team_id) : null;
      if (!team) continue;
      for (const playerId of [team.player_1_id, team.player_2_id].filter(Boolean)) {
        if (!perPlayer.has(playerId)) perPlayer.set(playerId, []);
        perPlayer.get(playerId).push(match);
      }
    }
  }

  const gaps = [];
  for (const [playerId, playerMatches] of perPlayer) {
    const ordered = [...playerMatches].sort(
      (a, b) => new Date(a.started_at) - new Date(b.started_at),
    );
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const next = ordered[i];
      if (localDate(previous.ended_at) !== localDate(next.started_at)) continue;
      gaps.push({
        player: playerName.get(playerId),
        gapMin: round1(minutesBetween(previous.ended_at, next.started_at)),
        from: previous.draw_id ? drawLabel(previous) : placementLabel(previous),
        to: next.draw_id ? drawLabel(next) : placementLabel(next),
      });
    }
  }

  gaps.sort((a, b) => a.gapMin - b.gapMin);
  return {
    sameDayPlayerTurnarounds: gaps.length,
    minMin: gaps[0]?.gapMin ?? null,
    medianMin: gaps.length ? gaps[Math.floor(gaps.length / 2)].gapMin : null,
    underFiveMinutes: gaps.filter((gap) => gap.gapMin < 5).length,
    underTenMinutes: gaps.filter((gap) => gap.gapMin < 10).length,
    tightest: gaps.slice(0, 5),
    note: "Consecutive matches for the same player on the same day, measured from the previous ended_at to the next started_at. The applicable gap depends on the later match's stage: 5 minutes placement, 10 minutes knockout. The desk may start a match early.",
  };
})();

const summary = {
  exportedAt: new Date().toISOString(),
  source: {
    project: PROJECT_REF,
    tournamentId: TOURNAMENT_ID,
    name: tournament.name,
    venueTimezone: VENUE_TZ,
    status: tournament.status,
    startsOn: tournament.starts_on,
    endsOn: tournament.ends_on,
    statusNote:
      "Every match is decided; the stored tournament status is still in_progress because completing the tournament is an operator action.",
  },
  settings: {
    venueTimezone: tournament.venue_timezone,
    groupSlotMinutes: tournament.group_slot_minutes,
    groupRestGapMinutes: tournament.group_rest_gap_minutes,
    knockoutSlotMinutes: tournament.knockout_slot_minutes,
    knockoutRestGapMinutes: tournament.knockout_rest_gap_minutes,
    courts: tournament.court_count,
    maxCategoriesPerPlayer: tournament.max_categories_per_player,
    placement: {
      gamesTo: tournament.placement_games_to,
      winBy: tournament.placement_win_by,
      bestOf: tournament.placement_best_of,
    },
    knockout: {
      gamesTo: tournament.knockout_games_to,
      winBy: tournament.knockout_win_by,
      bestOf: tournament.knockout_best_of,
    },
  },
  counts: {
    placementMatches: matches.length,
    placementReported: matches.filter((match) => match.status === "reported").length,
    drawMatches: tierDrawMatches.length,
    drawPlayed: drawPlayed.length,
    drawByes: tierDrawMatches.filter((match) => match.status === "bye").length,
    matchesPlayed: allPlayed.length,
    draws: tierDraws.length,
    championsCrowned: tierDraws.filter((draw) => draw.champion_id).length,
    entrants: entrants.length,
    teams: teams.length,
    players: players.length,
    activityRows: activityRows.length,
    activityAttached: activityRows.filter((row) => row.attached).length,
    activityOrphaned: activityRows.filter((row) => !row.attached).length,
    resultCorrections: matchResultHistory.length,
    nightsCrossed: nightMatches.length,
  },
  perCategory,
  stages: {
    placement: stageStats(placementPlayed, tournament.group_slot_minutes, spillIds),
    knockout: stageStats(drawPlayed, tournament.knockout_slot_minutes),
  },
  days: daysSummary,
  total: {
    matchesPlayed: allPlayed.length,
    courtMinutes: round1(totalCourtMinutes),
    courtCapacityMinutes: totalCapacity,
    utilization: round1((totalCourtMinutes / totalCapacity) * 1000) / 1000,
  },
  driftNote:
    "Placement drift excludes the two matches carried across the day boundary; their 19-hour figure is a planning decision, not intra-day reflow. Knockout drift includes time spent waiting for feeder results, because a bracket match is published before both sides are known.",
  carried,
  restGaps,
  activity: {
    byAction: activityByAction,
    byTable: activityByTable,
    byDate: activityByDate,
  },
  byes: tierDrawMatches.filter((match) => match.status === "bye").map((match) => drawLabel(match)),
  remaining: [],
  notes: [
    "Two knockout matches (MS draw A, round 1; XD draw C, round 1) were started without a published scheduled_time: the draw was built moments earlier and the desk started the match immediately. Their time-derived columns are blank, not zero.",
    "One time-shifted row moved a match earlier: XD r2-makeup-2 was published on day 2 at 12:01, pulled back to 17:01 on day 1 at 16:36, and returned to day 2 at 16:47. That is the only negative shift in the trail.",
    "Twenty-three activity rows at 15:03:07 belong to an abandoned build whose matches were deleted; they are attached = false. The nine 16:23-16:47 rows that the day-1 snapshot read as orphaned are tier-draw placements and are attached here; that snapshot's attached flag only checked the placement table.",
  ],
};

writeFileSync(join(HERE, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

console.log(
  `Wrote ${placementRows.length} placement matches, ${drawRows.length} draw matches, ` +
    `${activityRows.length} activity rows and summary.json to ${HERE}`,
);
