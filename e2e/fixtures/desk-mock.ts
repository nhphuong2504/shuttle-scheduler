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
 * An instant `minutes` from the fixture's reference time.
 *
 * This is anchored to `REFERENCE` - a fixed hour of the current day - and deliberately not
 * to `Date.now()`. It used to read `Math.max(DAY_START + 1min, Date.now() + minutes)`, which
 * clamped every seeded instant to just after midnight. The clamp was there so a "four hours
 * ago" match would not be dated yesterday and vanish from the day it was meant to populate,
 * but it destroyed the *spacing* between offsets whenever the day was young: at 00:05 both
 * `-50` and `-48` collapsed onto 00:01, so court 1's overrun match was only four minutes into
 * a fifteen-minute slot and derived as `playing` instead.
 *
 * That made these tests fail purely by the clock: between 00:00 and about 00:16 local, a
 * board seeded to show all five court states could not show `overrun` at all. CI runs in
 * UTC, so the gate was red for roughly a quarter of an hour after every UTC midnight, with
 * failures that had nothing to do with the change under test.
 *
 * Anchoring to a fixed hour removes the dependence entirely: offsets are applied to a
 * constant instant, so spacing is preserved and every state is reachable at any hour.
 * `REFERENCE` is midday because the widest offset used here is -240 minutes, which keeps
 * every seeded instant inside the same calendar day.
 *
 * The app must agree on "now" for any of this to mean anything, so `installAppMock` pins the
 * page clock to this same instant. The two are a pair: changing one without the other
 * reintroduces the drift, in the other direction.
 */
export const REFERENCE = new Date(DAY_START.getTime() + 12 * 60 * MINUTE);

const at = (minutes: number): string =>
  new Date(REFERENCE.getTime() + minutes * MINUTE).toISOString();

/**
 * The fixture day's own window, as instants: midnight and 23:59 of the reference day.
 *
 * `REFERENCE` is noon, so these are the two ends of the same local day the day row describes
 * (`00:00:00`-`23:59:00`). They exist for `tournament_summary`'s derived start and end.
 */
const DAY_OPEN = at(-12 * 60);
const DAY_CLOSE = at(12 * 60 - 1);

const TID = "00000000-0000-4000-8000-00000000ffff";
const CREATED = new Date(DAY_START.getTime() - DAY_MS).toISOString();

/** Deterministic UUID-shaped ids, so nothing depends on a random generator. */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * The auth identity the hermetic mock signs in as, and the profile that identity is
 * linked to.
 *
 * Every tournament relationship is stored as a *profile* id
 * (`tournaments.owner_profile_id`, `tournament_editors.profile_id`), which is a
 * different value from the auth user id. Both live here, beside the tournament they
 * belong to, because the mock's session, its `profiles` row and the fixture tournament
 * all have to agree - and three copies of a UUID is how they stop agreeing.
 *
 * `app-mock.ts` imports the auth id for the synthetic session; nothing in `src/` knows
 * either value.
 */
export const E2E_USER_ID = "00000000-0000-4000-8000-0000000000e2";
export const OWNER_PROFILE_ID = uid(1000);

/**
 * The profile that owns the fixture tournament when the session's profile does not.
 *
 * A viewer and an editor are not the owner, and `tournaments.owner_profile_id` is how
 * the app decides that - so serving a viewer the same owner id the session holds would
 * make the fixture lie, and the surface that reads the row (`/setup`'s list) would
 * disagree with the surface that reads `tournament_access`.
 */
export const OTHER_OWNER_PROFILE_ID = uid(1001);

/**
 * What the signed-in session is to the fixture tournament.
 *
 * One value rather than three separate overrides, because the three answers have to move
 * together: the `owner_profile_id` on the row, the membership rows, and the
 * `tournament_access` summary are three views of one fact, and a fixture that let them
 * disagree would be testing the disagreement rather than the app.
 */
export type MockMembership = "owner" | "editor" | "viewer";

/** The one tournament every preset serves. */
export const TOURNAMENT_ID = TID;

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

/**
 * The fixture's two events, by id.
 *
 * Exported because a spec that has to name an event - the registration queue showing capacity
 * for the event a request asked for - should name one that exists in the fixture rather than
 * paste a uuid that nothing guarantees.
 */
export const CATEGORY_MD = uid(800);
export const CATEGORY_XD = uid(801);

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
  // Ownership is a profile, not the auth identity. The fixture's session is that profile.
  owner_profile_id: OWNER_PROFILE_ID,
  // Registration is optional and absent here, which exercises the "no window" read.
  registration_opens_at: null,
  registration_closes_at: null,
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
 * The datasets this fixture can serve.
 *
 * One mock with several presets rather than several fixtures, because nine tenths of the
 * rows - players, teams, entrants, categories, courts, the tournament, the day - are
 * identical and only the match schedule differs. Duplicating the file would put two
 * copies of the tournament rule (best of three to 21) in the repository, and a fixture
 * whose own rules disagree with its own scores is how the widest-score case was wrong
 * once already.
 *
 * `layout` asks "does it fit"; `states` asks "does every state draw". They are
 * different questions about the same event, so they are two presets, not two events.
 *
 * `prebuild` is the seeded field before anything has been built: entrants with a locked
 * seed order, and no matches or draws at all. It exists for the stage reset's gate, which
 * has to be shown releasing as well as refusing — a fixture where the schedule is always
 * present can only ever prove the refusal, so a regression that disabled the reset
 * permanently would pass every other preset.
 */
export type DeskMockPreset = "layout" | "states" | "prebuild";

interface MockPreset {
  specs: MatchSpec[];
  /** The A/B/C/D brackets. Empty is "no build has run yet". */
  tierDraws: unknown[];
  pools: unknown[];
  entries: unknown[];
  poolMatches: unknown[];
}

const PRESETS: Record<DeskMockPreset, MockPreset> = {
  layout: { specs: LAYOUT_MATCH_SPECS, tierDraws, pools: [], entries: [], poolMatches: [] },
  states: {
    specs: STATE_MATCH_SPECS,
    tierDraws,
    pools: STATE_POOLS,
    entries: STATE_POOL_ENTRIES,
    poolMatches: STATE_POOL_MATCHES,
  },
  prebuild: { specs: [], tierDraws: [], pools: [], entries: [], poolMatches: [] },
};

/**
 * Table name to rows. Anything absent resolves to an empty array, which is the correct
 * answer for tables this surface does not read and keeps the mock from failing closed.
 *
 * The `profiles` row carries `system_role`, because the authorization model reads the
 * platform role from the profile as well as from `current_system_role()`. Both have to
 * say the same thing, or a surface that reads the row would disagree with one that reads
 * the RPC.
 */
/**
 * The lifecycle word the fixture tournament is served as.
 *
 * Narrowed to the three states that exist rather than left a `string`, so a spec cannot
 * ask for `"draft"` and quietly get a row the app labels unpredictably.
 */
export type MockTournamentStatus = "upcoming" | "in_progress" | "completed";

/**
 * The competition format the fixture tournament is served as.
 *
 * The fixture runs the two-round placement format, which is the one the app creates. The
 * round-robin word exists here so the day-by-day planner - the other view the single
 * `schedule` route can render - still has a rendered surface to be measured on, now that
 * format rather than URL decides which of the two renders.
 */
export type MockTournamentFormat = "two_round_placement" | "round_robin";

/**
 * The `tournament_summary` row for the fixture, in the wire shape the RPC returns.
 *
 * `access_level` is the caller's relationship to the row in the database's own order - the
 * platform role first, then ownership, then membership - so a spec cannot be served a card
 * that disagrees with `tournament_access` about the same caller.
 */
export interface MockTournamentSummary {
  id: string;
  name: string;
  venue_name: string;
  status: MockTournamentStatus | string;
  starts_at: string | null;
  ends_at: string | null;
  registration_state: string;
  entry_count: number;
  category_count: number;
  access_level: string;
}

/** The filters `tournament_summary` takes that this fixture models. */
export interface MockSummaryArgs {
  p_query?: string | null;
  p_status?: string | null;
  p_ids?: readonly string[] | null;
}

/**
 * Everything the mock serves for one page load: the table rows, and the RPC reads that are
 * derived from them.
 *
 * The summary is a *derived* read - its start and end come from the days, its counts from the
 * teams and the events, its registration state from the lifecycle and the window - so the
 * fixture derives it here rather than letting the transport invent one. Explore and My
 * Tournaments both draw cards from it, and a card that disagreed with the rows behind it
 * would be a spec measuring the disagreement.
 */
export interface DeskFixture {
  tables: Record<string, unknown[]>;
  /**
   * `tournament_summary`'s answer for one request.
   *
   * A function rather than a value because the read takes filters, and the filters belong to
   * the fixture that knows what the rows mean rather than to the transport that only knows
   * how to answer. It mirrors the function's semantics for `p_ids`, `p_status` and `p_query`
   * - `p_query` matching the name, the venue and the events, as the database does.
   *
   * Two things it deliberately does not restate: the unknown-status refusal (the function
   * raises, and a spec for that belongs in the integration suite where the real function
   * answers), and `p_limit`/`p_offset` (one row, so pagination is not a behaviour this
   * fixture can show).
   */
  tournamentSummaries: (args: MockSummaryArgs) => MockTournamentSummary[];
}

const buildFixture = (
  specs: MatchSpec[],
  draws: unknown[],
  pools: unknown[],
  entries: unknown[],
  poolMatches: unknown[],
  systemRole: string,
  status: MockTournamentStatus | undefined,
  membership: MockMembership,
  format: MockTournamentFormat | undefined,
  registrationState: string | null | undefined,
): DeskFixture => {
  // The lifecycle word is the one thing a spec needs to vary and cannot click its way
  // to: the fixture is a running event, and `Upcoming` and `Completed` are the other two
  // states the vocabulary has.
  const served: Record<string, unknown> =
    status || membership !== "owner" || format
      ? {
          ...tournament,
          ...(status ? { status } : {}),
          ...(format ? { format } : {}),
          ...(membership === "owner" ? {} : { owner_profile_id: OTHER_OWNER_PROFILE_ID }),
        }
      : tournament;

  const servedStatus = (served["status"] as MockTournamentStatus | undefined) ?? "in_progress";

  /**
   * The registration window as the database would compute it, for the fixture's own
   * configuration.
   *
   * The lifecycle answers first and the fixture configures no window at all, so a running or
   * finished tournament reads `started` / `completed` and an upcoming one reads `not_offered`.
   * The remaining words (`open`, `opens_soon`, `closed`) need a window this fixture does not
   * have; a spec that wants them arrives with one.
   *
   * ## Why `registrationState` overrides the two *reads* rather than one
   *
   * `tournament_summary` does not compute this word, it *calls*
   * `tournament_registration_state(t.id)` for it - so in the database the card on Explore and
   * the Register panel on the participant page are the same value from the same function, and
   * they cannot disagree. The fixture has to reproduce that or it is weaker than the system it
   * stands in for: a summary read saying `not_offered` beside an RPC saying `open` would let a
   * spec pass against a state no tournament can be in. So one option drives both, and the
   * lifecycle derivation below is only the *default* for a spec that asks for neither.
   */
  const lifecycleState =
    servedStatus === "completed"
      ? "completed"
      : servedStatus === "in_progress"
        ? "started"
        : "not_offered";
  const servedRegistrationState = registrationState ?? lifecycleState;

  const summary: MockTournamentSummary = {
    id: TID,
    name: tournament.name,
    venue_name: tournament.venue_name,
    status: servedStatus,
    // The fixture day is the whole local day (00:00 to 23:59 in the venue's timezone), and
    // these are those two instants. The venue-timezone conversion is `tournament_starts_at`'s
    // job rather than a transport double's, so what is asserted about them is ordering and
    // presence, not an offset arithmetic the mock would have to reimplement.
    starts_at: DAY_OPEN,
    ends_at: DAY_CLOSE,
    registration_state: servedRegistrationState,
    // The entry is `teams` and the events are `categories` - never a derived projection.
    entry_count: teams.length,
    category_count: categories.length,
    access_level:
      systemRole === "admin"
        ? "admin"
        : membership === "owner"
          ? "owner"
          : membership === "editor"
            ? "editor"
            : "viewer",
  };

  /** What `p_query` matches. The events are the third thing a person remembers. */
  const searchText = [
    tournament.name,
    tournament.venue_name,
    ...categories.flatMap((category) => [category.name, category.code]),
  ];

  return {
    tables: {
      tournaments: [served],
      tournament_days: days,
      tournament_day_courts: [],
      tournament_day_breaks: [],
      courts,
      categories,
      players,
      // The roster the app reads is the definer projection, not `players`: the table's own
      // policy keys on tournament edit access, which a participant does not have.
      public_players: players,
      teams,
      placement_entrants: entrants,
      placement_matches: [],
      draws: [],
      draw_matches: [],
      pools,
      pool_entries: entries,
      pool_matches: poolMatches,
      tier_draws: draws,
      tier_draw_matches: toRows(specs),
      tournament_editors:
        membership === "editor"
          ? [
              {
                tournament_id: TID,
                // The session's *profile*, not its auth id. Membership is held by a person
                // now, and serving the auth id here is exactly the mismatch identity canon
                // exists to remove.
                profile_id: OWNER_PROFILE_ID,
                added_by_profile_id: OTHER_OWNER_PROFILE_ID,
                created_at: CREATED,
              },
            ]
          : [],
      tournament_registrations: [],
      profiles: [
        {
          id: OWNER_PROFILE_ID,
          user_id: E2E_USER_ID,
          email: "desk@example.test",
          system_role: systemRole,
          current_tournament_id: TID,
          created_at: CREATED,
        },
        /**
         * The other owner: the person who owns the fixture tournament whenever the session
         * does not.
         *
         * It is a `profiles` row rather than a bare id because ownership is held by a
         * profile, and a surface that names the owner joins through this table to do it -
         * the access list is the one that does today, and without this row it drew the
         * owner's address as "—". `user_id` is NULL, which is the state the schema allows
         * and the phase-1 model described: a profile that owns a tournament before its
         * person has signed in. A read filtered by `user_id` therefore never returns it,
         * which is what keeps it out of the session's own lookup.
         */
        {
          id: OTHER_OWNER_PROFILE_ID,
          user_id: null,
          email: "host@example.test",
          system_role: "user",
          current_tournament_id: null,
          created_at: CREATED,
        },
      ],
    },

    tournamentSummaries: (args) => {
      const term = (args.p_query ?? "").trim().toLowerCase();
      if (args.p_ids && !args.p_ids.includes(TID)) return [];
      if (args.p_status && summary.status !== args.p_status) return [];
      if (term && !searchText.some((text) => text.toLowerCase().includes(term))) return [];
      return [summary];
    },
  };
};

/**
 * The rows this fixture serves, plus the reads derived from them.
 *
 * Built on every call rather than held at module scope, so a long test run cannot drift
 * the "minutes ago" values apart from the rows actually being served. The result is
 * frozen for the life of one page load, which is what makes a failure reproducible.
 *
 * Installing it is `installAppMock`'s job (`./app-mock`), which owns the transport,
 * the auth session and the safety net. This module is now data only.
 */
export function deskFixture(
  preset: DeskMockPreset = "layout",
  systemRole = "user",
  status?: MockTournamentStatus,
  membership: MockMembership = "owner",
  format?: MockTournamentFormat,
  registrationState?: string | null,
): DeskFixture {
  const chosen = PRESETS[preset];
  return buildFixture(
    chosen.specs,
    chosen.tierDraws,
    chosen.pools,
    chosen.entries,
    chosen.poolMatches,
    systemRole,
    status,
    membership,
    format,
    registrationState,
  );
}
