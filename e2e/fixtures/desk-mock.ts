import type { Page } from "@playwright/test";

/**
 * Deterministic, deliberately hostile data for the Desk layout validation.
 *
 * ## Why this exists at all
 *
 * The 12px floor and the tier sizes were measured, but measurement of *size* is not
 * measurement of *fit*. Every string the Desk renders in a real tournament is absent
 * from the live database: the active tournament has no courts, no teams and no
 * matches, so the court board has only ever rendered its empty state. A tier value can
 * be correct and still fail the moment a real pairing name meets a 1366px tile.
 *
 * ## Why it is built this way
 *
 * Three approaches were available and only one is honest:
 *
 *   1. Seed a tournament in the database. Rejected - the task forbids touching
 *      production data, and it would make the result depend on what a previous run
 *      left behind.
 *   2. Render components in jsdom. Rejected - jsdom has no layout engine, so
 *      `scrollWidth` is always 0 and overflow is unobservable. It can prove a class
 *      is present; it cannot prove the text fits.
 *   3. Intercept the network and serve synthetic rows to the real app in a real
 *      browser. Chosen. The real components run against the real stylesheet, so the
 *      thing being measured is the thing that ships, and nothing is written anywhere.
 *
 * ## What is fixed, and what is relative
 *
 * Names, counts, statuses, court numbers and scores are constants. Timestamps are
 * computed from the clock at call time, offset into the current local day, because
 * freezing the clock is not free: the page is server-rendered, and a browser-only
 * clock override makes the server's `now` and the client's `now` disagree, which React
 * reports as a hydration failure and then repairs. Injecting an error into the app
 * under test to make the harness tidier is the wrong trade - the assertions here are
 * about text fitting, and no assertion reads a timestamp. Relative times keep the
 * data honest and the run quiet.
 *
 * Offsets are clamped to after local midnight so a match can never be dated to
 * yesterday, which would drop it out of the day window and silently empty the board.
 * The suite is therefore runnable at any hour rather than only during office hours.
 *
 * ## What is deliberately pathological
 *
 * Long doubles pairings are two full names joined by " / ", which is the widest label
 * the Desk can be asked to draw. Scores reach 30-29, the cap in badminton, across three
 * games. Eight courts are active at once. These are the strings the layout has to
 * survive, not the average ones.
 */

export const VENUE_TZ = "America/Chicago";
export const COURT_COUNT = 8;

const DAY_START = new Date();
DAY_START.setHours(0, 0, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Local calendar date as `YYYY-MM-DD`, without going through UTC and shifting a day. */
export const DAY_DATE = `${DAY_START.getFullYear()}-${String(DAY_START.getMonth() + 1).padStart(2, "0")}-${String(DAY_START.getDate()).padStart(2, "0")}`;

/**
 * An instant `minutes` from now, never earlier than the start of the current day.
 *
 * The clamp is what makes the fixture hourly-agnostic: run at 01:00 and a "four hours
 * ago" match would otherwise be dated yesterday and vanish from the day it is meant to
 * populate.
 */
const at = (minutes: number): string =>
  new Date(Math.max(DAY_START.getTime() + MINUTE, Date.now() + minutes * MINUTE)).toISOString();

const TID = "00000000-0000-4000-8000-00000000ffff";
const CREATED = new Date(DAY_START.getTime() - DAY_MS).toISOString();

/** Deterministic UUID-shaped ids, so nothing depends on a random generator. */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const courtId = (n: number) => uid(100 + n);
const playerId = (n: number) => uid(200 + n);
const teamId = (n: number) => uid(300 + n);
const entrantId = (n: number) => uid(400 + n);
const matchId = (n: number) => uid(500 + n);
const dayId = uid(600);
const drawA = uid(700);
const drawC = uid(701);

/**
 * Twenty-four names, chosen to be plausible rather than absurd, but long enough that a
 * pairing is roughly 60-70 characters. `teamLabel` joins them with " / ".
 */
const NAMES = [
  "Alexandra Kristinsson-Watanabe",
  "Maria-Fernanda Delacroix-Vasquez",
  "Konstantinos Papadopoulos-Athanasiou",
  "Anne-Sophie Van Den Berg-Whitfield",
  "Maximilian Schwarzenegger-Hohenzollern",
  "Priyanka Venkateshwara-Chandrasekhar",
  "Sebastien Lefebvre-Dubuisson",
  "Ingrid Lindqvist-Bjorkman",
  "Oluwaseun Adebayo-Olawale",
  "Nguyen Thi Minh-Ha",
  "Radoslaw Wisniewski-Kowalczyk",
  "Charlotte Beaumont-Fitzgerald",
  "Hiroshi Yamamoto-Takahashi",
  "Elif Yildirim-Kahraman",
  "Bartholomew Featherstonehaugh",
  "Sanne Van Der Meer-Kloosterman",
  "Diego Fernandez-Castellanos",
  "Amara Nwachukwu-Okonkwo",
  "Jean-Baptiste Rouault-Marchand",
  "Katarina Petrovic-Jovanovic",
  "Takeshi Nakamura-Matsumoto",
  "Wilhelmina Van Rensburg-Steyn",
  "Fionnuala O'Doherty-McCullagh",
  "Ravindra Srinivas-Chandrasekaran",
];

export const LONGEST_NAME = NAMES[0]!;

/** The widest label the Desk can be asked to draw, asserted against directly. */
export const LONGEST_PAIRING = `${NAMES[0]} / ${NAMES[1]}`;

/** Three games ending at the 30-point cap: the widest score string that is legal today. */
const WIDE_GAMES = [
  { a: 30, b: 29 },
  { a: 29, b: 30 },
  { a: 30, b: 28 },
];
export const WIDEST_SCORE = "30-29, 29-30, 30-28";

const players = NAMES.map((name, i) => ({
  id: playerId(i + 1),
  name,
  email: null,
  phone: null,
  gender: i % 2 === 0 ? "M" : "F",
  created_at: CREATED,
}));

/** Twelve doubles teams: each pairs two consecutive names, so every label is long. */
const teams = Array.from({ length: 12 }, (_, i) => ({
  id: teamId(i + 1),
  tournament_id: TID,
  category_id: i < 6 ? uid(800) : uid(801),
  player_1_id: playerId(i * 2 + 1),
  player_2_id: playerId(i * 2 + 2),
  seed: i + 1,
  withdrawn: false,
  created_at: CREATED,
}));

const entrants = teams.map((team, i) => ({
  id: entrantId(i + 1),
  tournament_id: TID,
  category_id: team.category_id,
  team_id: team.id,
  seed: i + 1,
  seed_locked_at: null,
  excluded: false,
  skill_level: "B",
  tier: i < 6 ? "A" : "C",
}));

const categories = [
  {
    id: uid(800),
    tournament_id: TID,
    code: "MD",
    name: "Men's Doubles",
    entry_type: "individual",
    sort_order: 1,
    active: true,
    max_entries: null,
    gender: "men",
    created_at: CREATED,
  },
  {
    id: uid(801),
    tournament_id: TID,
    code: "XD",
    name: "Mixed Doubles",
    entry_type: "individual",
    sort_order: 2,
    active: true,
    max_entries: null,
    gender: "mixed",
    created_at: CREATED,
  },
];

const courts = Array.from({ length: COURT_COUNT }, (_, i) => ({
  id: courtId(i + 1),
  tournament_id: TID,
  number: i + 1,
  status: "free",
  created_at: CREATED,
}));

const tournament = {
  id: TID,
  name: "Layout Validation Invitational",
  venue_name: "Forker",
  venue_address: "600 Stonehaven Dr",
  venue_timezone: VENUE_TZ,
  organizer_name: "Layout Probe",
  organizer_email: "probe@example.test",
  organizer_phone: null,
  rest_gap_minutes: 10,
  group_slot_minutes: 20,
  knockout_slot_minutes: 15,
  group_rest_gap_minutes: 10,
  knockout_rest_gap_minutes: 30,
  court_count: COURT_COUNT,
  day_count: 1,
  is_active: true,
  status: "in_progress",
  format: "two_round_placement",
  max_categories_per_player: 3,
  placement_games_to: 21,
  placement_win_by: 2,
  placement_best_of: 1,
  // Best of three to 21, so the three-game 30-29 fixture score is a legal result rather
  // than a string the rules could never produce. At 20-20 a game runs to a 30 cap, which
  // is where the widest score on the board comes from.
  knockout_games_to: 21,
  knockout_win_by: 2,
  knockout_best_of: 3,
  notes: null,
  created_at: CREATED,
};

const days = [
  {
    id: dayId,
    tournament_id: TID,
    day_number: 1,
    date: DAY_DATE,
    // The whole day, so the selected day always contains the current instant.
    start_time: "00:00:00",
    end_time: "23:59:00",
    created_at: CREATED,
  },
];

const tierDraws = [
  {
    id: drawA,
    tournament_id: TID,
    category_id: uid(800),
    tier: "A",
    bracket_size: 16,
    entrant_count: 12,
    champion_id: null,
    created_at: CREATED,
  },
  {
    id: drawC,
    tournament_id: TID,
    category_id: uid(801),
    tier: "C",
    bracket_size: 16,
    entrant_count: 12,
    champion_id: null,
    created_at: CREATED,
  },
];

interface MatchSpec {
  n: number;
  draw: string;
  round: number;
  slot: number;
  a: number;
  b: number;
  status: string;
  court: number | null;
  /** Minutes from now, clamped into the current day. */
  scheduled: number | null;
  started: number | null;
  ended?: number | null;
  games?: { a: number; b: number }[];
  isBye?: boolean;
}

/**
 * One fixture match, positionally.
 *
 * Written as a helper rather than as object literals because thirteen rows of thirteen
 * named fields are past any sensible line width: the formatter would expand every row to
 * thirteen lines and the shape of the table - which courts are live, which are done, who
 * is on next - would stop being visible at a glance. The optional tail (a finished
 * match's end time and games) stays an object so that only the rows that need it pay for
 * it.
 */
const match = (
  n: number,
  draw: string,
  round: number,
  slot: number,
  a: number,
  b: number,
  status: string,
  court: number | null,
  scheduled: number | null,
  started: number | null,
  extra: { ended?: number; games?: { a: number; b: number }[]; isBye?: boolean } = {},
): MatchSpec => ({ n, draw, round, slot, a, b, status, court, scheduled, started, ...extra });

/**
 * The layout preset: eight courts all busy at once, with the widest strings the app
 * can be asked to draw. This is the fit question, not the state question.
 */
const LAYOUT_MATCH_SPECS: MatchSpec[] = [
  // Six matches live across six courts, with staggered starts so the timers differ and
  // the first is far enough past its slot to read as an overrun.
  match(1, drawA, 1, 1, 1, 2, "in-progress", 1, -240, -235),
  match(2, drawA, 1, 2, 3, 4, "in-progress", 2, -60, -58),
  match(3, drawA, 1, 3, 5, 6, "in-progress", 3, -35, -33),
  match(4, drawC, 1, 4, 7, 8, "in-progress", 4, -18, -16),
  match(5, drawC, 1, 5, 9, 10, "in-progress", 5, -10, -9),
  match(6, drawC, 1, 6, 11, 12, "in-progress", 6, -5, -4),
  // The widest legal score, reported, on the next two courts.
  match(7, drawA, 1, 7, 2, 5, "reported", 7, -150, -148, { ended: -110, games: WIDE_GAMES }),
  match(8, drawC, 1, 8, 4, 7, "reported", 8, -200, -198, { ended: -160, games: WIDE_GAMES }),
  // A walkover and a void sit on the board without a court, which is the state that
  // previously had no rendering at all.
  match(9, drawA, 2, 1, 1, 6, "walkover", null, -30, null, { ended: -28 }),
  match(10, drawC, 2, 2, 3, 12, "void", null, -30, null),
  // Queued for later, so the boards show a next-up state rather than only live play.
  match(11, drawA, 2, 3, 8, 9, "scheduled", 7, 30, null),
  match(12, drawC, 2, 4, 10, 11, "scheduled", 8, 50, null),
  // A bye, which the desk must drop rather than offer a result for.
  match(13, drawA, 1, 9, 12, 0, "scheduled", null, null, null, { isBye: true }),
];

/**
 * The states preset: one court per state, and every urgency treatment lit at once.
 *
 * The layout preset cannot do this. Six courts are live there, so four fifths of the
 * vocabulary is unreachable by construction - a court is in exactly one state, and
 * driving an app can only ever sample a vocabulary whose members are mutually
 * exclusive. So the rows here are chosen backwards from the states: each entry
 * below names the state it exists to produce and the reason that input produces it.
 *
 * Knockout pacing applies, because these are tier matches: a 15-minute slot and a
 * 30-minute rest gap. The boundaries are stated rather than round, so an assertion
 * against "overrun" is really asserting the configured slot was used.
 *
 * `is_bye` and `void` rows are deliberately absent. Both are filtered out of every
 * surface that renders without a session - a void match is excluded from the running
 * order because it never played, and a bye has no court or time by construction - so
 * including them here would only add rows that nothing draws. They are covered by
 * the component-level vocabulary tests, and the limitation is recorded in the canvas.
 */
const STATE_MATCH_SPECS: MatchSpec[] = [
  // Court 1 -> overrun. Live for 48 against a 15-minute slot.
  match(1, drawA, 1, 1, 1, 2, "in-progress", 1, -50, -48),
  // Court 2 -> playing. Live for 7, inside the slot.
  match(2, drawA, 1, 2, 3, 4, "in-progress", 2, -8, -7),
  // Court 3 -> free-ready. Nothing live; the next pairing has no history at all, so
  // nothing is resting and nobody is busy.
  match(3, drawA, 1, 3, 9, 10, "scheduled", 3, 20, null),
  // Court 4 -> free-blocked, resting. Entrant 6 finished 10 minutes ago on this court
  // and plays again here, and the knockout rest gap is 30, so ready in 20.
  match(4, drawA, 1, 4, 6, 7, "reported", 4, -40, -38, {
    ended: -10,
    games: [
      { a: 21, b: 15 },
      { a: 21, b: 18 },
    ],
  }),
  match(5, drawA, 1, 5, 6, 8, "scheduled", 4, 20, null),
  // Court 5 -> free-blocked, player busy. Entrant 3 is on court 2 right now, and busy
  // is checked before rest, so this stays busy rather than becoming resting.
  match(6, drawA, 1, 6, 3, 5, "scheduled", 5, 20, null),
  // A ready pairing with no court: the amber "ready but unplaced" alert. Its two
  // entrants appear nowhere else in this set on purpose - sharing a player with a
  // finished match made this read as resting, which is the other blocked state, and
  // that is a silent failure rather than a loud one.
  match(7, drawC, 1, 7, 11, 12, "scheduled", null, 25, null),
  // Courts 6, 7 and 8 have no rows at all, which is the idle state - and the only way
  // to reach it, since a court with anything live or scheduled is one of the others.
  // The archived statuses (reported, walkover) are deliberately not here: the running
  // order that draws them is covered by the `layout` preset, and adding them to this
  // one would only give their players a rest time that turns a ready court into a
  // blocked one.
];

/**
 * The late pool behind the one destructive alert.
 *
 * `poolIsComplete` returns false below four teams, so a four-team pool with nothing
 * played is incomplete by the same rule the real desk uses, and a scheduled end an
 * hour ago is more than the 15 minutes of grace the alert allows.
 */
const STATE_POOLS = [
  {
    id: uid(900),
    tournament_id: TID,
    category_id: uid(800),
    name: "Men's Doubles · Pool A",
    scheduled_end: at(-60),
    created_at: CREATED,
  },
];

const STATE_POOL_ENTRIES = [1, 2, 3, 4].map((n) => ({
  id: uid(910 + n),
  pool_id: uid(900),
  team_id: teamId(n),
  created_at: CREATED,
}));

const STATE_POOL_MATCHES: unknown[] = [];

/** Turns a spec list into the table rows the app reads. */
const toRows = (specs: MatchSpec[]) =>
  specs.map((s) => ({
    id: matchId(s.n),
    tournament_id: TID,
    draw_id: s.draw,
    round: s.round,
    slot: s.slot,
    court_id: s.court ? courtId(s.court) : null,
    status: s.status,
    scheduled_time: s.scheduled === null ? null : at(s.scheduled),
    started_at: s.started === null ? null : at(s.started),
    ended_at: s.ended == null ? null : at(s.ended),
    reported_time: s.status === "reported" && s.ended != null ? at(s.ended) : null,
    games: s.games ?? [],
    is_bye: s.isBye ?? false,
    // A bye has no second side, which is why it is dropped downstream.
    entrant_a_id: s.a === 0 ? null : entrantId(s.a),
    entrant_b_id: s.b === 0 ? null : entrantId(s.b),
    winner_id: s.status === "reported" || s.status === "walkover" ? entrantId(s.a) : null,
    parent_a_id: null,
    parent_b_id: null,
    note: null,
    created_at: CREATED,
  }));

/**
 * The two datasets this fixture can serve.
 *
 * One mock with two presets rather than two fixtures, because nine tenths of the rows
 * - players, teams, entrants, categories, courts, the tournament, the day - are
 * identical and only the match schedule differs. Duplicating the file would put two
 * copies of the tournament rule (best of three to 21) in the repository, and a fixture
 * whose own rules disagree with its own scores is how the widest-score case was wrong
 * once already.
 *
 * `layout` asks "does it fit"; `states` asks "does every state draw". They are
 * different questions about the same event, so they are two presets, not two events.
 */
export type DeskMockPreset = "layout" | "states";

const PRESETS: Record<
  DeskMockPreset,
  { specs: MatchSpec[]; pools: unknown[]; entries: unknown[]; poolMatches: unknown[] }
> = {
  layout: { specs: LAYOUT_MATCH_SPECS, pools: [], entries: [], poolMatches: [] },
  states: {
    specs: STATE_MATCH_SPECS,
    pools: STATE_POOLS,
    entries: STATE_POOL_ENTRIES,
    poolMatches: STATE_POOL_MATCHES,
  },
};

/**
 * Table name to rows. Anything absent resolves to an empty array, which is the correct
 * answer for tables this surface does not read and keeps the mock from failing closed.
 */
const tables = (
  specs: MatchSpec[],
  pools: unknown[],
  entries: unknown[],
  poolMatches: unknown[],
): Record<string, unknown[]> => ({
  tournaments: [tournament],
  tournament_days: days,
  tournament_day_courts: [],
  tournament_day_breaks: [],
  courts,
  categories,
  players,
  player_roster: players,
  teams,
  placement_entrants: entrants,
  placement_matches: [],
  draws: [],
  draw_matches: [],
  pools,
  pool_entries: entries,
  pool_matches: poolMatches,
  tier_draws: tierDraws,
  tier_draw_matches: toRows(specs),
  staff_roles: [],
});

/**
 * Serves the fixture to every Supabase REST call the app makes.
 *
 * Must be installed before the first navigation. Because the rows are built when this
 * is called and then frozen, the same page load always sees the same content, so a
 * failure is reproducible even though the timestamps are relative.
 */
export async function installDeskMock(
  page: Page,
  preset: DeskMockPreset = "layout",
): Promise<void> {
  // Built once here rather than at module scope, so a long test run cannot drift the
  // "minutes ago" values apart from the rows actually being served.
  const chosen = PRESETS[preset];
  const rows = tables(chosen.specs, chosen.pools, chosen.entries, chosen.poolMatches);

  await page.route("**/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const target = url.pathname.split("/rest/v1/")[1] ?? "";

    // The only RPCs the desk reaches. An unauthenticated role is the honest answer and
    // is what the layout question is asked against.
    if (target === "rpc/current_staff_role") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      return;
    }
    if (target.startsWith("rpc/tournament_readiness")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    const table = target.split("?")[0] ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rows[table] ?? []),
    });
  });
}
