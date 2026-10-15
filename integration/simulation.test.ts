import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import {
  completeTournament,
  createPlayer,
  createTeam,
  setTournamentDayBreaks,
} from "@/lib/tournament/actions";
import {
  fetchCourts,
  fetchPlacementEntrants,
  fetchPlacementMatches,
  fetchScheduleConflicts,
  fetchTierDrawMatches,
  fetchTierDraws,
  type Category,
  type Court,
  type PlacementEntrant,
  type PlacementMatch,
  type ScheduleConflict,
  type ScheduleConflictKind,
  type Team,
  type TierDraw,
  type TierDrawMatch,
  type Tournament,
  type TournamentDay,
  type TournamentDayBreak,
} from "@/lib/tournament/data";
import {
  generateMissingStages,
  lockPlacementSeeds,
  reportPlacementMatch,
  reportTierDrawMatch,
  startPlacementMatch,
  startTierDrawMatch,
  syncPlacementEntrants,
} from "@/lib/tournament/placement-actions";
import {
  applyPlacementSchedulePlan,
  planPlacementSchedule,
} from "@/lib/tournament/placement-schedule";
import { mulberry32, type RandomFn } from "@/lib/tournament/rng";

import {
  createIdentity,
  createOwnedTournament,
  destroyIdentity,
  destroyTournaments,
  serviceClient,
  type TestIdentity,
} from "./env";

/**
 * A two-day placement tournament, played start to finish against the real backend.
 *
 * WHAT THIS IS
 *
 * A simulation, not a scripted lifecycle. `lifecycle.test.ts` proves the states can be walked
 * in order; this plays a whole field the way the desk does - build the schedule, take the
 * earliest scheduled match, start it, report it, let the database reflow the rest of the day,
 * and repeat until a champion exists - and checks the invariants a real event depends on after
 * EVERY step rather than only at the end. A reflow bug does not show up as a wrong final
 * answer; it shows up as two matches on one court at 11:20, and only a per-step check sees it.
 * The one overlap that is *not* a bug - a match the reflow held at the day's close - is checked
 * against `schedule_conflicts` rather than waved through, and is required to be gone after every
 * Update schedule; see `assertInvariants`.
 *
 * It drives the application's own action layer (`generateMissingStages`, `planPlacementSchedule`,
 * `applyPlacementSchedulePlan`, `report*Match`) for the same reason `lifecycle.test.ts` does: a
 * re-implementation of the payloads would test a copy of the logic.
 *
 * THE VIRTUAL CLOCK
 *
 * The tournament is dated in the past so the first-match gate is open, and a test cannot wait
 * for a real afternoon. The report RPCs stamp `ended_at = COALESCE(ended_at, now())` and the
 * start RPCs `started_at = COALESCE(started_at, now())`, so the simulation writes its own
 * `started_at`/`ended_at` (service role, a fixture and never an assertion) BEFORE reporting.
 * The reflow then sees the virtual times and does the same work it would on the day, including
 * matches that overrun.
 *
 * REPRODUCIBLE
 *
 * Everything random comes from one seeded generator. A failure prints the seed; rerun with
 * `SIM_SEED=<n> npm run test:integration -- simulation` to replay the same tournament.
 *
 * LIMITS, STATED UP FRONT
 *
 *   - The planner's own `now` is the virtual clock, but the database's `statement_timestamp()`
 *     (used for in-progress matches inside the reflow) is real time. The simulation reports
 *     each match before starting the next, so no match is in progress while a reflow runs.
 *   - Player rest gaps are reported as warnings, not failures: the reflow keeps them, but a
 *     simulated overrun can legitimately consume them.
 *   - A held overlap (a match the reflow kept at the day's close, then reported through
 *     `schedule_conflicts`) is tolerated and logged after a result, and required to be gone after
 *     every Update schedule. See `assertInvariants`.
 *   - Runs against the LOCAL stack only (AGENTS.md): `npx supabase start`,
 *     `npm run integration:target -- local`.
 */

// --- Configuration -------------------------------------------------------------

const SEED = Number(process.env["SIM_SEED"] ?? 20260101);
const TIMEZONE = "America/Chicago";
/**
 * Five courts, nine hours, two days. The field below needs roughly fifty to sixty court-hours
 * against about eighty available, so the first day cannot hold it and the schedule has to spill
 * into day two - which is the thing a two-day simulation exists to exercise - without being so
 * tight that the planner has no room to absorb an overrun.
 */
const COURTS = [1, 2, 3, 4, 5];
const DAYS = [
  { date: "2020-01-04", startTime: "09:00", endTime: "18:00", courts: COURTS },
  { date: "2020-01-05", startTime: "09:00", endTime: "18:00", courts: COURTS },
];
const BREAK = { label: "Lunch", startTime: "12:00", endTime: "12:40" };
/** Chance a match runs long, and how long, in minutes. */
const OVERRUN_CHANCE = 0.25;
const OVERRUN_RANGE: [number, number] = [10, 25];
const MAX_STEPS = 1000;
const MINUTE = 60_000;

/**
 * The field: 50 people (30 men `m0..m29`, 20 women `f0..f19`) in five events, 58 entries.
 *
 * Players overlap on purpose, because the interesting scheduling constraint is a person who
 * cannot be in two places:
 *   - m10..m14 play MS + MD + XD (three events)
 *   - f0, f1   play WS + XD + WD (three events)
 *   - m0..m9, m15..m17, f2..f9, f10, f11 play two events
 *   - everyone else plays one
 * so the tournament must allow three events per player (`max_categories_per_player`).
 */
type EntryRef = [string, string | null];
interface EventSpec {
  code: string;
  name: string;
  entryType: "individual" | "pair";
  gender: "men" | "women" | "mixed";
  entries: EntryRef[];
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const EVENTS: EventSpec[] = [
  {
    code: "MS",
    name: "Men's Singles",
    entryType: "individual",
    gender: "men",
    entries: [...range(0, 19), 28, 29].map((i) => [`m${i}`, null] as EntryRef),
  },
  {
    code: "WS",
    name: "Women's Singles",
    entryType: "individual",
    gender: "women",
    entries: range(0, 11).map((i) => [`f${i}`, null] as EntryRef),
  },
  {
    code: "MD",
    name: "Men's Doubles",
    entryType: "pair",
    gender: "men",
    entries: range(0, 7).map((i) => [`m${10 + i}`, `m${20 + i}`] as EntryRef),
  },
  {
    code: "WD",
    name: "Women's Doubles",
    entryType: "pair",
    gender: "women",
    entries: [
      ["f10", "f12"],
      ["f11", "f13"],
      ["f14", "f15"],
      ["f16", "f17"],
      ["f18", "f19"],
      ["f0", "f1"],
    ],
  },
  {
    code: "XD",
    name: "Mixed Doubles",
    entryType: "pair",
    gender: "mixed",
    entries: [
      ...range(0, 4).map((i) => [`m${10 + i}`, `f${i}`] as EntryRef),
      ...range(0, 4).map((i) => [`m${i}`, `f${5 + i}`] as EntryRef),
    ],
  },
];

type Side = "a" | "b";
interface Game {
  a: number;
  b: number;
}
type MatchKind = "placement" | "tier";

interface Slot {
  kind: MatchKind;
  row: PlacementMatch | TierDrawMatch;
}

// --- State shared by the steps ---------------------------------------------------

let admin: TestIdentity;
let tournamentId: string | undefined;
let dayRows: TournamentDay[] = [];
const playerIds: string[] = [];
const random: RandomFn = mulberry32(SEED);
const warnings: string[] = [];
/** Held overlaps tolerated so far, so the final log shows the held mechanism ran. */
let heldOverlaps = 0;
/** Set once the full run finishes, so the later steps can refuse to run on a broken one. */
let played = false;
/** Virtual "now", advanced as matches finish. */
let clock = 0;
const courtFreeAt = new Map<string, number>();

beforeAll(async () => {
  admin = await createIdentity("admin", "simulation");
  const { error } = await supabase.auth.signInWithPassword({
    email: admin.email,
    password: admin.password,
  });
  if (error) throw new Error(`signing in the application client failed: ${error.message}`);
}, 120_000);

afterAll(async () => {
  const failures: string[] = [];
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (cause) {
      failures.push(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  await step("delete the tournament", () => destroyTournaments(tournamentId));
  await step("delete the players", async () => {
    if (playerIds.length > 0) await serviceClient().from("players").delete().in("id", playerIds);
  });
  await step("sign out the application client", async () => {
    await supabase.auth.signOut();
  });
  await step("destroy the identity", () => destroyIdentity(admin));
  if (failures.length > 0) {
    throw new Error(`simulation teardown did not finish cleanly:\n  - ${failures.join("\n  - ")}`);
  }
}, 120_000);

// --- Reading the tournament ------------------------------------------------------

interface Snapshot {
  tournament: Tournament;
  days: TournamentDay[];
  courts: Court[];
  dayCourtIds: Map<string, Set<string>>;
  breaksByDay: Map<string, TournamentDayBreak[]>;
  categories: Category[];
  teams: Team[];
  entrants: PlacementEntrant[];
  placement: PlacementMatch[];
  tier: TierDrawMatch[];
  draws: TierDraw[];
}

function must<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

async function snapshot(): Promise<Snapshot> {
  const id = tournamentId as string;
  const db = admin.client;
  const [tournament, days, courts, categories, dayCourts, breaks] = await Promise.all([
    db.from("tournaments").select("*").eq("id", id).single().then(must),
    db.from("tournament_days").select("*").eq("tournament_id", id).order("day_number").then(must),
    fetchCourts(id),
    db.from("categories").select("*").eq("tournament_id", id).order("sort_order").then(must),
    db.from("tournament_day_courts").select("*").eq("tournament_id", id).then(must),
    db.from("tournament_day_breaks").select("*").eq("tournament_id", id).then(must),
  ]);
  const [teams, entrants, placement, tier, draws] = await Promise.all([
    db
      .from("teams")
      .select("*")
      .in("category_id", (categories as Category[]).map((c) => c.id))
      .then(must),
    fetchPlacementEntrants(id),
    fetchPlacementMatches(id),
    fetchTierDrawMatches(id),
    fetchTierDraws(id),
  ]);

  const dayCourtIds = new Map<string, Set<string>>();
  for (const row of dayCourts as { day_id: string; court_id: string }[]) {
    const set = dayCourtIds.get(row.day_id) ?? new Set<string>();
    set.add(row.court_id);
    dayCourtIds.set(row.day_id, set);
  }
  const breaksByDay = new Map<string, TournamentDayBreak[]>();
  for (const row of breaks as TournamentDayBreak[]) {
    breaksByDay.set(row.day_id, [...(breaksByDay.get(row.day_id) ?? []), row]);
  }

  return {
    tournament: tournament as Tournament,
    days: days as TournamentDay[],
    courts,
    dayCourtIds,
    breaksByDay,
    categories: categories as Category[],
    teams: teams as Team[],
    entrants,
    placement,
    tier,
    draws,
  };
}

/**
 * The conflicts `schedule_conflicts` reports right now.
 *
 * Fetched by the caller and handed to `assertInvariants`, which is synchronous: the held-overlap
 * tolerance needs the database's own view of which still-`scheduled` matches are actionable, and the
 * RPC is the only thing that computes it.
 */
async function conflictsNow(): Promise<ScheduleConflict[]> {
  return fetchScheduleConflicts(tournamentId as string);
}

// --- Scheduling ------------------------------------------------------------------

/** Generates whatever stage is missing, then plans and applies the whole queue. */
/**
 * The planner's "now" when Update schedule is pressed.
 *
 * The simulation plays courts one after another, so `clock` (the end of the last match played)
 * runs ahead of the other courts' next matches, which in a real venue would already be on court.
 * Handing the planner that clock makes every one of those matches look overdue, and an overdue
 * match that has not started is released and moved to "now" - so each rebuild would push every
 * other court forward and the delay would compound until the last matches spilled onto a third day.
 * The planner's "now" is therefore the earliest start still ahead: nothing unplayed is in the past,
 * which is what a real desk with concurrent courts looks like.
 *
 * This means the simulation never exercises the rule that releases a pin whose time has passed;
 * that rule is covered by the unit tests in `placement-schedule.test.ts`.
 */
function plannerNow(snap: Snapshot): number {
  const next = playable(snap)[0];
  return next ? Math.min(clock, Date.parse(next.row.scheduled_time as string)) : clock;
}

async function buildSchedule(): Promise<{ generated: number }> {
  let snap = await snapshot();
  const outcome = await generateMissingStages({
    categories: snap.categories,
    entrants: snap.entrants,
    matches: snap.placement,
    draws: snap.draws,
  });
  const generated =
    outcome.generated.roundOne + outcome.generated.roundTwo + outcome.generated.draws;
  if (generated > 0) snap = await snapshot();

  const plan = planPlacementSchedule({
    tournament: snap.tournament,
    days: snap.days,
    allCourts: snap.courts,
    dayCourtIds: snap.dayCourtIds,
    breaksByDayId: snap.breaksByDay,
    teams: snap.teams,
    entrants: snap.entrants,
    draws: snap.draws,
    placementMatches: snap.placement,
    tierMatches: snap.tier,
    categoryOrder: new Map(snap.categories.map((c) => [c.id, c.sort_order])),
    now: plannerNow(snap),
  });
  // A plan with nothing to place is not an error; a plan that cannot place something is, and
  // `applyPlacementSchedulePlan` says which.
  await applyPlacementSchedulePlan(plan);
  return { generated };
}

// --- Playing a match -------------------------------------------------------------

function slotMinutes(t: Tournament, kind: MatchKind): number {
  return kind === "placement" ? t.group_slot_minutes : t.knockout_slot_minutes;
}

/**
 * A winning game score under the tournament's rule.
 *
 * The loser stays strictly below the rule's target; with win-by-two there is a small chance of
 * a deuce (target+1 against target-1), because that is the score shape that breaks naive
 * validators.
 */
function gameScore(winner: Side, gamesTo: number, winBy: number): Game {
  let win = gamesTo;
  let lose = Math.floor(random() * Math.max(1, gamesTo - winBy));
  if (winBy >= 2 && random() < 0.15) {
    lose = gamesTo - 1;
    win = gamesTo - 1 + winBy;
  }
  return winner === "a" ? { a: win, b: lose } : { a: lose, b: win };
}

/** A best-of-N result for `winner`. The deciding game is always the winner's. */
function buildGames(winner: Side, gamesTo: number, winBy: number, bestOf: number): Game[] {
  const needed = (bestOf + 1) / 2;
  const loserWins = needed > 1 && random() < 0.35 ? 1 : 0;
  const order: Side[] = [];
  for (let i = 0; i < needed - 1; i += 1) order.push(winner);
  for (let i = 0; i < loserWins; i += 1) {
    order.splice(Math.floor(random() * (order.length + 1)), 0, winner === "a" ? "b" : "a");
  }
  order.push(winner);
  return order.map((side) => gameScore(side, gamesTo, winBy));
}

function rulesFor(t: Tournament, kind: MatchKind) {
  return kind === "placement"
    ? { gamesTo: t.placement_games_to, winBy: t.placement_win_by, bestOf: t.placement_best_of }
    : { gamesTo: t.knockout_games_to, winBy: t.knockout_win_by, bestOf: t.knockout_best_of };
}

/** The scheduled, playable matches right now, earliest first. */
function playable(snap: Snapshot): Slot[] {
  const slots: Slot[] = [];
  for (const row of snap.placement) {
    if (row.status === "scheduled" && row.court_id && row.scheduled_time && row.entrant_a_id && row.entrant_b_id) {
      slots.push({ kind: "placement", row });
    }
  }
  for (const row of snap.tier) {
    if (
      row.status === "scheduled" &&
      !row.is_bye &&
      row.court_id &&
      row.scheduled_time &&
      row.entrant_a_id &&
      row.entrant_b_id
    ) {
      slots.push({ kind: "tier", row });
    }
  }
  return slots.sort(
    (x, y) => Date.parse(x.row.scheduled_time as string) - Date.parse(y.row.scheduled_time as string),
  );
}

/**
 * Starts and reports one match on the virtual clock.
 *
 * The match starts at its scheduled time or when its court frees up, whichever is later; it
 * lasts the slot plus, sometimes, an overrun. The virtual `started_at`/`ended_at` are written
 * before the report so the reflow reads them instead of the wall clock.
 */
async function playMatch(slot: Slot, snap: Snapshot): Promise<{ overran: number }> {
  const { row, kind } = slot;
  const table = kind === "placement" ? "placement_matches" : "tier_draw_matches";
  const court = row.court_id as string;
  const start = Math.max(Date.parse(row.scheduled_time as string), courtFreeAt.get(court) ?? 0);
  const overran =
    random() < OVERRUN_CHANCE
      ? Math.round(OVERRUN_RANGE[0] + random() * (OVERRUN_RANGE[1] - OVERRUN_RANGE[0]))
      : 0;
  const end = start + (slotMinutes(snap.tournament, kind) + overran) * MINUTE;

  if (kind === "placement") await startPlacementMatch(row.id, court);
  else await startTierDrawMatch(row.id, court);

  const { error } = await serviceClient()
    .from(table)
    .update({
      started_at: new Date(start).toISOString(),
      ended_at: new Date(end).toISOString(),
    })
    .eq("id", row.id);
  if (error) throw new Error(`setting the virtual clock failed: ${error.message}`);

  const rule = rulesFor(snap.tournament, kind);
  const winner: Side = random() < 0.5 ? "a" : "b";
  const games = buildGames(winner, rule.gamesTo, rule.winBy, rule.bestOf);
  if (kind === "placement") await reportPlacementMatch(row.id, games, tournamentId as string);
  else await reportTierDrawMatch(row.id, games, tournamentId as string);

  courtFreeAt.set(court, end);
  clock = Math.max(clock, end);
  return { overran };
}

// --- Invariants ---------------------------------------------------------------------

interface Block {
  label: string;
  /** The row's own id, so an overlap can be matched against `schedule_conflicts`. */
  id: string;
  court: string;
  start: number;
  end: number;
  scheduled: boolean;
  players: string[];
}

function blocksOf(snap: Snapshot): Block[] {
  const teamById = new Map(snap.teams.map((t) => [t.id, t]));
  const entrantPlayers = new Map<string, string[]>();
  for (const e of snap.entrants) {
    const team = teamById.get(e.team_id);
    if (team) {
      entrantPlayers.set(
        e.id,
        [team.player_1_id, team.player_2_id].filter((p): p is string => !!p),
      );
    }
  }
  const out: Block[] = [];
  const push = (kind: MatchKind, r: PlacementMatch | TierDrawMatch) => {
    if (!r.court_id || !r.scheduled_time) return;
    if (r.status === "void" || r.status === "bye") return;
    if (kind === "tier" && (r as TierDrawMatch).is_bye) return;
    const scheduled = r.status === "scheduled";
    const start = Date.parse((scheduled ? r.scheduled_time : (r.started_at ?? r.scheduled_time)) as string);
    const end =
      !scheduled && r.ended_at
        ? Date.parse(r.ended_at)
        : start + slotMinutes(snap.tournament, kind) * MINUTE;
    out.push({
      label: `${kind}:${r.id.slice(0, 8)} (${r.status})`,
      id: r.id,
      court: r.court_id,
      start,
      end,
      scheduled,
      players: [
        ...(entrantPlayers.get(r.entrant_a_id ?? "") ?? []),
        ...(entrantPlayers.get(r.entrant_b_id ?? "") ?? []),
      ],
    });
  };
  for (const r of snap.placement) push("placement", r);
  for (const r of snap.tier) push("tier", r);
  return out;
}

function fmt(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { timeZone: TIMEZONE, hour12: false });
}

interface InvariantOptions {
  /**
   * The conflicts `schedule_conflicts` currently reports, so a held overlap can be recognised.
   * Fetched by the caller because this check is synchronous and the RPC is not.
   */
  conflicts?: readonly ScheduleConflict[] | undefined;
  /**
   * Refuse every overlap between two still-`scheduled` matches. Set after Update schedule, when the
   * reflow's held overlaps must have been resolved; left false after a bare result, when the reflow
   * may legitimately have left one. See `assertInvariants`.
   */
  strict?: boolean | undefined;
}

/** The conflict kinds that mark a held, still-movable overlap of each shape. */
const HELD_OVERLAP_KINDS: Record<"court" | "player", readonly ScheduleConflictKind[]> = {
  court: ["court_overlap"],
  player: ["rest_shortfall", "court_overlap"],
};

/** The closing instant of the day `at` falls in, or null when no configured day contains it. */
function dayCloseFor(snap: Snapshot, at: number): number | null {
  const key = localDate(at);
  const day = snap.days.find((d) => d.date === key);
  return day ? Date.parse(localToIso(day.date, day.end_time)) : null;
}

/**
 * Whether an overlap that ends in a still-`scheduled` match is the reflow's held behaviour rather
 * than a bug.
 *
 * When a result pushes the rest of a day past its close, the reflow may not move the whole day into
 * the next one, so it holds the match it cannot fit: it keeps the published time, and so does the
 * tail behind it. The held match then overlaps the match pushed in front of it - on the same court,
 * and often for the same player. That overlap is deliberate and is surfaced by `schedule_conflicts`;
 * Update schedule is what clears it. So it is tolerated only while BOTH hold:
 *
 *   (a) it genuinely could not be avoided inside the day. Pushed to start when the earlier match
 *       ends, the later one would still finish past its day's closing time. This is the half that
 *       keeps a real reflow bug out: a push that WOULD have fitted must have been made.
 *   (b) the database names the later match as an actionable conflict of the matching kind
 *       (`court_overlap` for a court, `rest_shortfall`/`court_overlap` for a player). An overlap no
 *       conflict row names is one the desk cannot see, so it can never be a tolerated held overlap.
 *
 * Either half failing keeps the overlap a violation. The LATER match must still be `scheduled`: it
 * is the one the desk can move, so it is the one the conflict is raised against. The EARLIER match
 * may be in any state - the usual case is the very match whose overrun triggered the reflow, which
 * is `reported` by then, and the held match left behind it overlaps it. What stays a violation is a
 * later match that is already done or on court: that is history overlapping history, a real double
 * booking the reflow can neither cause nor repair.
 */
function isHeldOverlap(args: {
  prev: Block;
  cur: Block;
  kind: "court" | "player";
  snap: Snapshot;
  conflicts: readonly ScheduleConflict[];
}): boolean {
  const { prev, cur, kind, snap, conflicts } = args;
  if (!cur.scheduled) return false;
  const dayClose = dayCloseFor(snap, cur.start);
  if (dayClose == null) return false;
  const duration = cur.end - cur.start;
  if (prev.end + duration <= dayClose) return false;
  return conflicts.some(
    (conflict) =>
      conflict.match_id === cur.id && HELD_OVERLAP_KINDS[kind].includes(conflict.conflict_kind),
  );
}

/**
 * The invariants a live event depends on. Throws with the step that broke them.
 *
 *   1. one court never holds two matches at once
 *   2. one player is never in two matches at once
 *   3. a still-scheduled match never overlaps a break (the reflow's job since the break fix)
 *
 * INVARIANTS 1 AND 2 HAVE ONE SANCTIONED EXCEPTION, AND ONLY ONE. A result can make the rest of a day
 * run past its close; the reflow will not move the day into the next one and will not refuse the
 * result, so it holds the match it cannot fit. The held match keeps its published time, and so does
 * the tail behind it, so it overlaps the match pushed in front of it - and the desk is told through
 * `schedule_conflicts` rather than the overlap being hidden. `isHeldOverlap` accepts exactly that
 * overlap and nothing else. Every other overlap - including any overlap with a match that is no
 * longer `scheduled` - is still a failure.
 *
 * After Update schedule the exception is withdrawn entirely (`strict`): the rebuild exists to resolve
 * those held overlaps, so a still-`scheduled` match overlapping another after a build is a planner
 * bug waiting for the desk, not a held match.
 */
function assertInvariants(snap: Snapshot, step: string, options: InvariantOptions = {}): void {
  const { conflicts = [], strict = false } = options;
  const blocks = blocksOf(snap);
  const problems: string[] = [];

  const byCourt = new Map<string, Block[]>();
  for (const b of blocks) byCourt.set(b.court, [...(byCourt.get(b.court) ?? []), b]);
  for (const list of byCourt.values()) {
    list.sort((x, y) => x.start - y.start);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1] as Block;
      const cur = list[i] as Block;
      if (cur.start < prev.end) {
        if (!strict && isHeldOverlap({ prev, cur, kind: "court", snap, conflicts })) {
          heldOverlaps += 1;
          warnings.push(`${step}: court overlap tolerated, held at the close: ${prev.label} / ${cur.label}`);
        } else {
          problems.push(`court overlap: ${prev.label} ends ${fmt(prev.end)}, ${cur.label} starts ${fmt(cur.start)}`);
        }
      }
    }
  }

  const byPlayer = new Map<string, Block[]>();
  for (const b of blocks) for (const p of b.players) byPlayer.set(p, [...(byPlayer.get(p) ?? []), b]);
  for (const [player, list] of byPlayer) {
    list.sort((x, y) => x.start - y.start);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1] as Block;
      const cur = list[i] as Block;
      if (cur.start < prev.end) {
        if (!strict && isHeldOverlap({ prev, cur, kind: "player", snap, conflicts })) {
          heldOverlaps += 1;
          warnings.push(
            `${step}: player ${player.slice(0, 8)} overlap tolerated, held at the close: ${prev.label} / ${cur.label}`,
          );
        } else {
          problems.push(`player ${player.slice(0, 8)} double-booked: ${prev.label} / ${cur.label}`);
        }
      } else if (cur.start < prev.end + snap.tournament.group_rest_gap_minutes * MINUTE) {
        warnings.push(`${step}: player ${player.slice(0, 8)} rests under the gap: ${prev.label} / ${cur.label}`);
      }
    }
  }

  for (const day of snap.days) {
    for (const brk of snap.breaksByDay.get(day.id) ?? []) {
      const bs = Date.parse(localToIso(day.date, brk.start_time));
      const be = Date.parse(localToIso(day.date, brk.end_time));
      for (const b of blocks) {
        if (b.scheduled && b.start < be && b.end > bs) {
          problems.push(`${b.label} is scheduled ${fmt(b.start)} inside the ${day.date} break`);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`[seed ${SEED}] invariants broken after ${step}:\n  - ${problems.join("\n  - ")}`);
  }
}

/** A venue-local wall time as an ISO instant. DST-safe enough for the January dates used here. */
function localToIso(date: string, time: string): string {
  const hhmm = time.slice(0, 5);
  const guess = new Date(`${date}T${hhmm}:00Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: TIMEZONE }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() + (utc.getTime() - local.getTime())).toISOString();
}

function localDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

/**
 * Which round of which event a match belongs to, and whether that round is now finished.
 *
 * A placement round is an event's `round1` or `round2`; a knockout round is one round of one
 * tier's bracket. "Finished" means nothing in it is still waiting to be played, which is the
 * moment the host would press Update schedule.
 */
function roundOf(slot: Slot, snap: Snapshot): { key: string; label: string; done: boolean } {
  const code = (categoryId: string) =>
    snap.categories.find((c) => c.id === categoryId)?.code ?? categoryId.slice(0, 6);
  const open = (status: string) => status === "scheduled" || status === "in-progress";
  if (slot.kind === "placement") {
    const row = slot.row as PlacementMatch;
    const group = snap.placement.filter(
      (m) => m.category_id === row.category_id && m.stage === row.stage,
    );
    return {
      key: `p:${row.category_id}:${row.stage}`,
      label: `${code(row.category_id)} ${row.stage}`,
      done: group.every((m) => !open(m.status)),
    };
  }
  const row = slot.row as TierDrawMatch;
  const draw = snap.draws.find((d) => d.id === row.draw_id);
  const group = snap.tier.filter((m) => m.draw_id === row.draw_id && m.round === row.round && !m.is_bye);
  return {
    key: `t:${row.draw_id}:${row.round}`,
    label: `${draw ? code(draw.category_id) : "?"} tier ${draw?.tier ?? "?"} round ${row.round}`,
    done: group.every((m) => !open(m.status)),
  };
}

// --- The simulation ----------------------------------------------------------------

describe("a two-day placement tournament, played end to end", () => {
  it("plays 50 players across five events, updating the schedule as each event finishes a round", async () => {
    tournamentId = await createOwnedTournament(admin, {
      name: `itest-sim-${Date.now().toString(36)}`,
      timezone: TIMEZONE,
      days: DAYS,
    });

    // --- Events and the per-player cap ---------------------------------------------
    // Creation gives one Men's Singles event; replace it with the five this field needs. Some
    // players are in three events, so the cap (default two) is raised to three.
    const events = await admin.client.rpc("save_tournament_categories", {
      p_tournament_id: tournamentId,
      p_categories: EVENTS.map((event, index) => ({
        code: event.code,
        name: event.name,
        entry_type: event.entryType,
        gender: event.gender,
        sort_order: index + 1,
        active: true,
        max_entries: null,
      })),
    } as never);
    if (events.error) throw new Error(`save_tournament_categories failed: ${events.error.message}`);
    const capped = await serviceClient()
      .from("tournaments")
      .update({ max_categories_per_player: 3 })
      .eq("id", tournamentId);
    if (capped.error) throw new Error(`raising the category cap failed: ${capped.error.message}`);

    const first = await snapshot();
    dayRows = first.days;
    expect(dayRows).toHaveLength(2);
    for (const day of dayRows) {
      await setTournamentDayBreaks(tournamentId, day.id, [BREAK]);
    }
    expect(first.courts.length).toBe(COURTS.length);
    const categoryByCode = new Map(first.categories.map((c) => [c.code, c.id]));
    expect([...categoryByCode.keys()].sort()).toEqual(EVENTS.map((e) => e.code).sort());

    // --- Players, then entries -----------------------------------------------------
    const tag = Date.now().toString(36);
    const refs = [...new Set(EVENTS.flatMap((e) => e.entries.flat()).filter((r): r is string => !!r))];
    expect(refs).toHaveLength(50);
    const idOf = new Map<string, string>();
    for (const ref of refs) {
      const id = await createPlayer({
        name: `sim ${tag} ${ref}`,
        gender: ref.startsWith("m") ? "M" : "F",
      });
      expect(id, `creating ${ref} returned no id`).toBeTruthy();
      idOf.set(ref, id);
      playerIds.push(id);
    }

    let totalEntries = 0;
    for (const event of EVENTS) {
      for (const [one, two] of event.entries) {
        await createTeam({
          categoryId: categoryByCode.get(event.code) as string,
          player1: idOf.get(one) as string,
          player2: two ? (idOf.get(two) as string) : null,
        });
        totalEntries += 1;
      }
    }
    expect(totalEntries).toBe(58);

    // The overlap this field is built around: m10 is in MS, MD and XD.
    const m10Teams = must(
      await admin.client
        .from("teams")
        .select("category_id")
        .or(`player_1_id.eq.${idOf.get("m10")},player_2_id.eq.${idOf.get("m10")}`),
    ) as { category_id: string }[];
    expect(new Set(m10Teams.map((t) => t.category_id)).size).toBe(3);

    // --- Seeds, per event ------------------------------------------------------------
    for (const event of EVENTS) {
      const id = categoryByCode.get(event.code) as string;
      await syncPlacementEntrants(id);
      const inEvent = (await fetchPlacementEntrants(tournamentId)).filter((e) => e.category_id === id);
      expect(inEvent, `${event.code} entrants`).toHaveLength(event.entries.length);
      await lockPlacementSeeds(id, inEvent, random);
    }

    // The window is in the past; the virtual clock starts when day one opens.
    clock = Date.parse(localToIso(DAYS[0]?.date as string, DAYS[0]?.startTime as string));

    // --- The event ---------------------------------------------------------------
    // The first Build lays out round one of every event. After that the host presses "Update
    // schedule" each time an event finishes a round - which here is the moment the last match
    // of a round is reported - and that rebuild generates the event's next stage and replans the
    // day around everything already played. Playing never waits for the other events.
    let matchesPlayed = 0;
    let overruns = 0;
    const completed = new Set<string>();
    const updates: string[] = [];
    await buildSchedule();
    assertInvariants(await snapshot(), "initial build", {
      conflicts: await conflictsNow(),
      strict: true,
    });

    for (let steps = 1; ; steps += 1) {
      expect(steps, "the tournament did not converge").toBeLessThan(MAX_STEPS);
      let snap = await snapshot();
      let next = playable(snap)[0];
      if (!next) {
        // Nothing left to play. A stage may still be waiting to be generated (the last event to
        // finish has no one left to trigger an update), so press it once more before giving up.
        const { generated } = await buildSchedule();
        snap = await snapshot();
        next = playable(snap)[0];
        if (!next && generated === 0) break;
        if (!next) continue;
      }

      const { overran } = await playMatch(next, snap);
      if (overran > 0) overruns += 1;
      matchesPlayed += 1;
      const after = await snapshot();
      assertInvariants(after, `match ${matchesPlayed}`, { conflicts: await conflictsNow() });

      const round = roundOf(next, after);
      if (round.done && !completed.has(round.key)) {
        completed.add(round.key);
        updates.push(round.label);
        await buildSchedule();
        // Update schedule must have resolved every held overlap the reflow left.
        assertInvariants(await snapshot(), `update schedule after ${round.label}`, {
          conflicts: await conflictsNow(),
          strict: true,
        });
      }
    }

    // --- Outcome ---------------------------------------------------------------
    const done = await snapshot();
    expect(matchesPlayed).toBeGreaterThan(totalEntries / 2);
    // Every event reached a knockout, and each press of Update schedule followed a finished round.
    expect(new Set(done.draws.map((d) => d.category_id)).size, "every event was drawn").toBe(EVENTS.length);
    expect(updates.length, "an update per finished round").toBeGreaterThanOrEqual(EVENTS.length * 2);
    expect(done.draws.length, "no knockout was drawn").toBeGreaterThan(0);
    for (const draw of done.draws) {
      expect(draw.champion_id, `tier ${draw.tier} has no champion`).toBeTruthy();
    }
    const unplayed = [...done.placement, ...done.tier].filter(
      (m) => m.status === "scheduled" && !(m as TierDrawMatch).is_bye,
    );
    expect(unplayed, "matches were left unplayed").toHaveLength(0);

    // The point of two days: play really did spill over.
    const datesUsed = new Set(
      [...done.placement, ...done.tier]
        .filter((m) => m.scheduled_time)
        .map((m) => localDate(Date.parse(m.scheduled_time as string))),
    );
    expect([...datesUsed].sort()).toEqual(DAYS.map((d) => d.date));

    // The whole bracket was drawn up front: size - 1 slots, one final, and every slot above round
    // one linked to the two matches that feed it.
    for (const draw of done.draws.filter((d) => d.bracket_size > 1)) {
      const matches = done.tier.filter((m) => m.draw_id === draw.id);
      expect(matches, `tier ${draw.tier} slot count`).toHaveLength(draw.bracket_size - 1);
      for (const m of matches.filter((x) => x.round > 1)) {
        expect(m.parent_a_id && m.parent_b_id, `tier ${draw.tier} r${m.round}s${m.slot} parents`).toBeTruthy();
      }
    }

    // Every knockout entrant is the winner of the match that feeds it.
    for (const draw of done.draws) {
      const matches = done.tier.filter((m) => m.draw_id === draw.id);
      const at = (round: number, slot: number) => matches.find((m) => m.round === round && m.slot === slot);
      for (const m of matches.filter((x) => x.round > 1)) {
        expect(m.entrant_a_id, `tier ${draw.tier} r${m.round}s${m.slot} side a`).toBe(
          at(m.round - 1, 2 * m.slot - 1)?.winner_id,
        );
        expect(m.entrant_b_id, `tier ${draw.tier} r${m.round}s${m.slot} side b`).toBe(
          at(m.round - 1, 2 * m.slot)?.winner_id,
        );
      }
    }

    played = true;
    console.info(
      `[seed ${SEED}] ${matchesPlayed} matches, ${overruns} overran, ${updates.length} schedule updates, ${done.draws.length} knockout draws, ` +
        `${heldOverlaps} held overlaps tolerated, ${warnings.length} warnings`,
    );
    for (const w of warnings.slice(0, 10)) console.info(`  warn: ${w}`);
  }, 900_000);

  it("refuses to change a winner after the next round was built from it, and allows a score fix", async () => {
    expect(played, "the simulation did not finish; nothing to correct").toBe(true);
    const snap = await snapshot();

    const flip = (m: PlacementMatch | TierDrawMatch, kind: MatchKind): Game[] => {
      const rule = rulesFor(snap.tournament, kind);
      const newWinner: Side = m.winner_id === m.entrant_a_id ? "b" : "a";
      return buildGames(newWinner, rule.gamesTo, rule.winBy, rule.bestOf);
    };
    const keep = (m: PlacementMatch | TierDrawMatch, kind: MatchKind): Game[] => {
      const rule = rulesFor(snap.tournament, kind);
      const winner: Side = m.winner_id === m.entrant_a_id ? "a" : "b";
      return buildGames(winner, rule.gamesTo, rule.winBy, rule.bestOf);
    };

    // Round one -> round two (placement).
    const roundOne = snap.placement.find((m) => m.stage === "round1" && m.status === "reported");
    expect(roundOne, "no reported round-one match").toBeTruthy();
    await expect(
      reportPlacementMatch((roundOne as PlacementMatch).id, flip(roundOne as PlacementMatch, "placement"), tournamentId as string),
    ).rejects.toThrow(/round two was built from this result/i);

    // Same winner, different score: a correction that changes nothing downstream.
    await expect(
      reportPlacementMatch((roundOne as PlacementMatch).id, keep(roundOne as PlacementMatch, "placement"), tournamentId as string),
    ).resolves.toBeDefined();

    // A knockout result whose child match has already been played.
    const parent = snap.tier.find(
      (m) =>
        m.status === "reported" &&
        !m.is_bye &&
        snap.tier.some(
          (c) =>
            c.draw_id === m.draw_id &&
            c.round === m.round + 1 &&
            c.slot === Math.ceil(m.slot / 2) &&
            c.status === "reported",
        ),
    );
    expect(parent, "no knockout parent with a played child").toBeTruthy();
    await expect(
      reportTierDrawMatch((parent as TierDrawMatch).id, flip(parent as TierDrawMatch, "tier"), tournamentId as string),
    ).rejects.toThrow(/already started/i);

    // And the schedule is still coherent after the refused and accepted corrections.
    assertInvariants(await snapshot(), "corrections", { conflicts: await conflictsNow() });
  }, 300_000);

  it("completes once nothing is on court", async () => {
    expect(played, "the simulation did not finish").toBe(true);
    await completeTournament(tournamentId as string);
    const { data } = await admin.client
      .from("tournaments")
      .select("status")
      .eq("id", tournamentId as string)
      .single();
    expect(data?.status).toBe("completed");
  }, 120_000);
});
