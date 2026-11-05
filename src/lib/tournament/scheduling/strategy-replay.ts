/**
 * A replay of a whole tournament, to compare how the schedule is kept up to date as results come in.
 *
 * The question it answers: when a result makes new matches ready, is it better to slot them into
 * the gaps the current schedule leaves (`place-ready`, which never moves a published time), or to
 * re-solve the whole queue (`rebuild`, which sees everything but may move times that were already
 * published)? Arguing it is cheap and unreliable, so this plays the same tournament under each
 * strategy and measures what the players and the organiser would have lived through.
 *
 * It is pure TypeScript with a virtual clock: no database, no RPC. It calls the real
 * `planPlacementSchedule`, so the solver, the freeze rules and the closing-time rules are the
 * product's own. What it replaces is everything around the planner:
 *
 *   - Rows are synthetic but shaped like the real ones (placement round one, round two paired by
 *     record, A/B/C/D brackets from `buildTierBracket`, winners moving up by `childSlot`).
 *   - Outcomes are seeded coin flips, and match lengths jitter around the slot, so the day drifts
 *     the way a real one does.
 *   - The live reflow SQL is stood in for by a minimal "push later matches on the same court"
 *     cascade, applied identically to every strategy and not counted as a strategy's own move.
 *
 * It does not model the real ranking rules or player availability, so absolute numbers are
 * indicative; the comparison between strategies on identical input is what it is for.
 */

import type {
  Court,
  PlacementEntrant,
  PlacementMatch,
  Team,
  TierDraw,
  TierDrawMatch,
  Tournament,
  TournamentDay,
} from "../data";
import {
  planPlacementSchedule,
  readyUnplacedCount,
  type PlacementSchedulePlan,
} from "../placement-schedule";
import { inProgressEnd } from "../in-progress";
import { buildRebuildSuggestion, type RebuildSuggestion } from "../rebuild-suggestion";
import { buildPlacementRoundTwo, pairPlacementRoundOne } from "../placement";
import { resolvePlacementFeederSlots } from "../placement-feeders";
import {
  buildCategoryView,
  decidedWinners,
  heldEntrantId,
  toEntrantRefs,
  toGeneratedMatches,
} from "../placement-actions";
import { buildTierBracket, childSlot, isTierMatchReady } from "../tier-draw";
import type { DayOneSchedulerOptions } from "./policy";

const MINUTE = 60_000;

export type StrategyName =
  | "place-ready"
  | "rebuild"
  | "gated-rebuild"
  | "manual-rounds"
  | "place-then-compact"
  | "rebuild-leftshift"
  | "place-ready-pull"
  | "gated-leftshift"
  | "rolling-horizon"
  | "future-days";

export const STRATEGIES: readonly StrategyName[] = [
  "place-ready",
  "rebuild",
  "gated-rebuild",
  "manual-rounds",
  "place-then-compact",
  "rebuild-leftshift",
  "place-ready-pull",
  "gated-leftshift",
  "rolling-horizon",
  "future-days",
];

/** An event's real entries: who plays with whom, with the identities replaced by labels. */
export interface FieldSpec {
  events: readonly { code: string; entrants: readonly { players: readonly string[] }[] }[];
}

export interface ReplayConfig {
  seed: number;
  /** Compare old whole-round release with fixed feeders, using the real format builders. */
  roundTwoRelease?: "whole-round" | "feeders";
  /** Pin each match's outcome to its ID so release strategies see identical results. */
  pairedOutcomes?: boolean;
  /** Entrants per event; each must be a multiple of four so every tier is filled. */
  events: readonly number[];
  /**
   * A real field of entries. When set, `events` and `sharedPlayersPerEvent` are ignored, seeds are a
   * seeded shuffle, and round one, round two and the draws are produced by the product's own pure
   * builders (`pairPlacementRoundOne`, `buildPlacementRoundTwo`, `buildCategoryView`), so odd fields,
   * the held entrant, make-up matches and the crossover all happen as they would for real.
   */
  field?: FieldSpec | undefined;
  /** Slot and rest lengths in minutes; defaults to 30 / 20 for placement and 45 / 30 for knockout. */
  timing?: { groupSlot: number; groupRest: number; koSlot: number; koRest: number } | undefined;
  /** Match length as a fraction of the slot (instead of `jitterMinutes`): -0.3 to 0.6 is 30 % faster to 60 % slower. */
  jitterFraction?: { min: number; max: number } | undefined;
  courts: number;
  /** Entrants per event who also play in the previous event, so players overlap across events. */
  sharedPlayersPerEvent: number;
  /** Actual match length is the slot plus a draw from this range, in minutes. */
  jitterMinutes: { min: number; max: number };
  /** Solver search knobs, to see whether searching harder changes the plan. */
  plannerOptions?: DayOneSchedulerOptions | undefined;
  /** Give every event the same category order, to take soft ordering out of the question. */
  flatCategoryOrder?: boolean | undefined;
  /** Number of playing days, one after another from 17 September 2026. */
  dayCount: number;
  /** Closing time of every day, `HH:MM:SS`. */
  dayEnd: string;
  /** `place-then-compact`: pin everything starting within this long, and apply a compaction only if it gains this much. */
  compact: { freezeMinutes: number; minGainMinutes: number };
  /** Gate for `gated-rebuild`: refuse a plan that postpones a match this soon by more than this. */
  gate: { windowMinutes: number; maxPostponeMinutes: number };
}

export const DEFAULT_CONFIG: ReplayConfig = {
  seed: 1,
  events: [8, 8, 12, 12, 8],
  courts: 6,
  sharedPlayersPerEvent: 2,
  jitterMinutes: { min: -10, max: 25 },
  dayCount: 2,
  dayEnd: "18:00:00",
  compact: { freezeMinutes: 180, minGainMinutes: 15 },
  gate: { windowMinutes: 120, maxPostponeMinutes: 30 },
};

export interface ReplayMetrics {
  strategy: StrategyName;
  seed: number;
  matches: number;
  finishMs: number;
  overrunMinutes: number;
  courtIdleMinutes: number;
  waitSumMinutes: number;
  waitP95Minutes: number;
  waitMaxMinutes: number;
  /** Published times pushed later by the strategy itself (not the reflow). */
  postponements: number;
  postponeSumMinutes: number;
  postponeMaxMinutes: number;
  advancements: number;
  /** Strategy-made changes to a time that was less than an hour / half an hour away. */
  changesWithin60: number;
  changesWithin30: number;
  /** Postponements made inside the last hour: the change that hurts a waiting player most. */
  postponementsWithin60: number;
  /** Postponements the gate would have refused: soon, and by more than the allowed amount. */
  gateBreaches: number;
  readyToTimedMeanMinutes: number;
  readyToTimedP95Minutes: number;
  startLatenessMeanMinutes: number;
  startLatenessP95Minutes: number;
  /** Actual start against the time FIRST published for the match: what a player waited overall. */
  delayVsFirstMeanMinutes: number;
  delayVsFirstP95Minutes: number;
  /** Share of matches that started 30 or more minutes after the time first published. */
  startedLate30Share: number;
  /** When the last match ended, in minutes after 09:00 on day one. */
  lastEndMinutes: number;
  gateRejections: number;
  /**
   * Plans that put a court's next match before the match running on it really ends. Each one is a
   * published time that the live reflow will have to push later.
   */
  falseFree: number;
  falseFreeMinutes: number;
  /** Times the stand-in for the live reflow pushed a published time later, and by how much in total. */
  reflowPushes: number;
  reflowPushMinutes: number;
  /** Times the organiser would have had to press Review/Rebuild for the run to finish. */
  manualPresses: number;
  failedApplies: number;
  planRuns: number;
  planMsTotal: number;
  planMsMax: number;
  stuck: boolean;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** A small seeded generator, so a run is reproducible and two strategies see the same dice. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const TOURNAMENT_ID = "replay";
const DAY_ONE = "2026-09-17";
const DAY_TWO = "2026-09-18";

type Row = PlacementMatch | TierDrawMatch;

interface EventState {
  index: number;
  categoryId: string;
  entrantIds: string[];
  seedOf: Map<string, number>;
  roundTwoMade: boolean;
  drawsMade: boolean;
  /** `W`/`L` per round, so the tier is the record: WW, WL, LW, LL. */
  record: Map<string, string>;
  /** True when the product's own builders drive this event (a real field). */
  real?: boolean;
  /** Generated key to match id, so a prerequisite key can be turned into an id. */
  idOfKey?: Map<string, string>;
}

interface World {
  tournament: Tournament;
  days: TournamentDay[];
  courts: Court[];
  teams: Team[];
  entrants: PlacementEntrant[];
  draws: TierDraw[];
  placement: PlacementMatch[];
  tier: TierDrawMatch[];
  categoryOrder: Map<string, number>;
  events: EventState[];
  playersOfEntrant: Map<string, string[]>;
  rng: () => number;
}

function tournamentRow(courts: number, timing?: ReplayConfig["timing"]): Tournament {
  return {
    id: TOURNAMENT_ID,
    is_demo: false,
    name: "Replay Open",
    block_start_on_short_rest: false,
    court_count: courts,
    created_at: "2026-09-17T00:00:00Z",
    day_count: 2,
    ends_on: DAY_TWO,
    format: "two_round_placement",
    group_rest_gap_minutes: timing?.groupRest ?? 20,
    group_slot_minutes: timing?.groupSlot ?? 30,
    knockout_best_of: 3,
    knockout_games_to: 21,
    knockout_rest_gap_minutes: timing?.koRest ?? 30,
    knockout_slot_minutes: timing?.koSlot ?? 45,
    knockout_win_by: 2,
    max_categories_per_player: 2,
    notes: null,
    organizer_email: null,
    organizer_name: null,
    organizer_phone: null,
    placement_best_of: 1,
    placement_games_to: 21,
    placement_win_by: 2,
    rest_gap_minutes: 30,
    starts_on: DAY_ONE,
    status: "in_progress",
    owner_profile_id: "00000000-0000-0000-0000-0000000000a1",
    registration_opens_at: null,
    registration_closes_at: null,
    venue_address: null,
    venue_name: null,
    // Every instant here is built on the process's clock (`setHours`, `${DAY_ONE}T09:00:00`), so the
    // venue is that same zone: the planner reads day windows on the venue's clock, and the two
    // must agree or every replay shifts by the machine's offset from UTC.
    venue_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  } as Tournament;
}

function placementRow(
  id: string,
  categoryId: string,
  stage: "round1" | "round2",
  a: string,
  b: string,
): PlacementMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: categoryId,
    stage,
    generation_key: id,
    entrant_a_id: a,
    entrant_b_id: b,
    winner_id: null,
    games: [],
    is_makeup: false,
    is_crossover: false,
    prerequisite_ids: [],
    court_id: null,
    scheduled_time: null,
    started_at: null,
    ended_at: null,
    reported_time: null,
    status: "scheduled",
    note: null,
    created_at: "2026-09-17T00:00:00Z",
  } as PlacementMatch;
}

function tierRow(
  id: string,
  drawId: string,
  round: number,
  slot: number,
  a: string | null,
  b: string | null,
  extra: Partial<TierDrawMatch> = {},
): TierDrawMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    draw_id: drawId,
    round,
    slot,
    entrant_a_id: a,
    entrant_b_id: b,
    winner_id: null,
    parent_a_id: null,
    parent_b_id: null,
    games: [],
    is_bye: false,
    court_id: null,
    scheduled_time: null,
    started_at: null,
    ended_at: null,
    reported_time: null,
    status: "scheduled",
    note: null,
    created_at: "2026-09-17T00:00:00Z",
    ...extra,
  } as TierDrawMatch;
}

export function buildWorld(config: ReplayConfig): World {
  const rng = mulberry32(config.seed);
  const teams: Team[] = [];
  const entrants: PlacementEntrant[] = [];
  const events: EventState[] = [];
  const placement: PlacementMatch[] = [];
  const playersOfEntrant = new Map<string, string[]>();
  const categoryOrder = new Map<string, number>();

  const specs: { size: number; players?: readonly (readonly string[])[] }[] = config.field
    ? config.field.events.map((event) => ({
        size: event.entrants.length,
        players: event.entrants.map((entrant) => entrant.players),
      }))
    : config.events.map((size) => ({ size }));

  specs.forEach((spec, e) => {
    const size = spec.size;
    if (!config.field && size % 4 !== 0) {
      throw new Error("Each event needs a multiple of four entrants.");
    }
    const categoryId = `cat-${e}`;
    categoryOrder.set(categoryId, e);
    const state: EventState = {
      index: e,
      categoryId,
      entrantIds: [],
      seedOf: new Map(),
      roundTwoMade: false,
      drawsMade: false,
      record: new Map(),
      ...(config.field ? { real: true, idOfKey: new Map<string, string>() } : {}),
    };
    // A real field is seeded by a seeded shuffle (the organiser assigns seeds by skill, which we do not
    // know); the synthetic field is seeded in entry order.
    const seeds = Array.from({ length: size }, (_, i) => i + 1);
    if (config.field) {
      for (let i = seeds.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [seeds[i], seeds[j]] = [seeds[j] as number, seeds[i] as number];
      }
    }
    for (let i = 0; i < size; i += 1) {
      const entrantId = `e-${e}-${i}`;
      // The first few entrants reuse a player from the previous event, so the same person can be
      // wanted on two courts, which is what makes a schedule hard.
      const previous = events[e - 1];
      const fieldPlayers = spec.players?.[i];
      const player =
        i < config.sharedPlayersPerEvent && previous && !config.field
          ? `p-${e - 1}-${previous.entrantIds.length - 1 - i}`
          : `p-${e}-${i}`;
      const people = fieldPlayers ? [...fieldPlayers] : [player];
      teams.push({
        id: `team-${e}-${i}`,
        tournament_id: TOURNAMENT_ID,
        category_id: categoryId,
        player_1_id: people[0] as string,
        player_2_id: people[1] ?? null,
        seed: null,
        withdrawn: false,
        created_at: "2026-09-17T00:00:00Z",
      } as Team);
      entrants.push({
        id: entrantId,
        tournament_id: TOURNAMENT_ID,
        category_id: categoryId,
        team_id: `team-${e}-${i}`,
        skill_level: "intermediate",
        seed: seeds[i] as number,
        tier: null,
        excluded: false,
        seed_locked_at: config.field ? "2026-09-17T00:00:00Z" : null,
        created_at: "2026-09-17T00:00:00Z",
      } as PlacementEntrant);
      state.entrantIds.push(entrantId);
      state.seedOf.set(entrantId, seeds[i] as number);
      playersOfEntrant.set(entrantId, people);
    }
    if (config.field) {
      // Round one exactly as the product pairs it: half-split by seed, the middle seed held when odd.
      const planOne = pairPlacementRoundOne(
        state.entrantIds.map((id) => ({ id, seed: state.seedOf.get(id) as number })),
      );
      for (const m of planOne.matches) {
        const id = `pm-${e}-${m.key}`;
        const row = placementRow(id, categoryId, "round1", m.entrantAId, m.entrantBId);
        row.generation_key = m.key;
        state.idOfKey?.set(m.key, id);
        placement.push(row);
      }
    } else {
      for (let i = 0; i < size / 2; i += 1) {
        placement.push(
          placementRow(
            `pm-${e}-1-${i}`,
            categoryId,
            "round1",
            state.entrantIds[i] as string,
            state.entrantIds[size - 1 - i] as string,
          ),
        );
      }
    }
    events.push(state);
  });

  const dates = Array.from({ length: config.dayCount }, (_, i) => dayDate(i));
  const days: TournamentDay[] = dates.map(
    (date, index) =>
      ({
        id: `d${index + 1}`,
        tournament_id: TOURNAMENT_ID,
        day_number: index + 1,
        date,
        start_time: "09:00:00",
        end_time: config.dayEnd,
        created_at: "2026-09-17T00:00:00Z",
      }) as TournamentDay,
  );
  const courts: Court[] = Array.from(
    { length: config.courts },
    (_, i) =>
      ({
        id: `c${i + 1}`,
        number: i + 1,
        status: "available",
        tournament_id: TOURNAMENT_ID,
        created_at: "2026-09-17T00:00:00Z",
      }) as Court,
  );

  return {
    tournament: tournamentRow(config.courts, config.timing),
    days,
    courts,
    teams,
    entrants,
    draws: [],
    placement,
    tier: [],
    categoryOrder,
    events,
    playersOfEntrant,
    rng,
  };
}

/** `YYYY-MM-DD` for the playing day at this zero-based index. */
export function dayDate(index: number): string {
  const d = new Date(2026, 8, 17 + index);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const rowsOf = (world: World): Row[] => [...world.placement, ...world.tier];
const isTier = (row: Row): row is TierDrawMatch => "draw_id" in row;
const slotMinutes = (world: World, row: Row) =>
  isTier(row) ? world.tournament.knockout_slot_minutes : world.tournament.group_slot_minutes;
const restMinutes = (world: World, row: Row) =>
  isTier(row) ? world.tournament.knockout_rest_gap_minutes : world.tournament.group_rest_gap_minutes;
const playersOf = (world: World, row: Row): string[] =>
  [row.entrant_a_id, row.entrant_b_id].flatMap((id) => (id ? (world.playersOfEntrant.get(id) ?? []) : []));
const isLive = (row: Row) => row.status !== "void" && !(isTier(row) && row.is_bye);

/** Both sides known, still to be played: what a viewer would call a match. */
function isReady(row: Row): boolean {
  if (row.status !== "scheduled") return false;
  if (!isTier(row)) return row.entrant_a_id != null && row.entrant_b_id != null;
  return isTierMatchReady({
    entrantAId: row.entrant_a_id,
    entrantBId: row.entrant_b_id,
    isBye: row.is_bye,
    status: row.status,
  });
}

// ---------------------------------------------------------------------------
// Stage generation (synthetic, same for every strategy)
// ---------------------------------------------------------------------------

function winnerOf(world: World): boolean {
  return world.rng() < 0.5;
}

/**
 * Round two and the draws for an event driven by the product's own builders, in the order
 * `generateMissingStages` would ask for them: fixed feeders open independently unless the
 * comparison requests the old whole-round release. Adaptive fields retain their full-round
 * gate, and knockout still needs complete placement records.
 */
function generateRealStages(
  world: World,
  event: EventState,
  release: ReplayConfig["roundTwoRelease"],
): number {
  let created = 0;
  const entrants = world.entrants.filter((e) => e.category_id === event.categoryId);
  const matches = world.placement
    .filter((m) => m.category_id === event.categoryId)
    .sort((a, b) =>
      a.generation_key < b.generation_key ? -1 : a.generation_key > b.generation_key ? 1 : 0,
    );
  const view = buildCategoryView(entrants, matches);

  const fixedFeeders = release !== "whole-round" && view.roundTwoSlots.length > 0;

  if (
    fixedFeeders || (view.stage === "round2" && view.roundTwo.length === 0 && view.roundTwoExpected)
  ) {
    const planTwo = fixedFeeders
      ? {
          matches: resolvePlacementFeederSlots(
            view.roundTwoSlots,
            toGeneratedMatches(view.roundOne),
            decidedWinners(view.roundOne),
          ),
        }
      : buildPlacementRoundTwo({
          entrants: toEntrantRefs(view.active),
          roundOne: toGeneratedMatches(view.roundOne),
          roundOneWinners: decidedWinners(view.roundOne),
          heldEntrantId: heldEntrantId(view.active, matches),
        });
    for (const m of planTwo.matches) {
      const id = `pm-${event.index}-${m.key}`;
      if (world.placement.some((row) => row.id === id)) continue;
      const row = placementRow(id, event.categoryId, "round2", m.entrantAId, m.entrantBId);
      row.generation_key = m.key;
      row.is_makeup = m.isMakeup;
      row.is_crossover = m.isCrossover;
      row.prerequisite_ids = m.prerequisiteKeys
        .map((key) => event.idOfKey?.get(key))
        .filter((value): value is string => value != null);
      event.idOfKey?.set(m.key, id);
      world.placement.push(row);
      created += 1;
    }
    event.roundTwoMade =
      !fixedFeeders ||
      world.placement.filter((m) => m.category_id === event.categoryId && m.stage === "round2")
        .length === view.roundTwoSlots.length;
  }

  if (view.stage === "draws" && !event.drawsMade) {
    for (const tier of ["A", "B", "C", "D"] as const) {
      const members = view.byTier[tier];
      if (members.length < 2) continue;
      const plan = buildTierBracket(
        tier,
        members.map((m) => ({ id: m.entrantId, seed: m.seed })),
      );
      const drawId = `draw-${event.index}-${tier}`;
      world.draws.push({
        id: drawId,
        tournament_id: TOURNAMENT_ID,
        category_id: event.categoryId,
        tier,
        bracket_size: plan.bracketSize,
        entrant_count: plan.entrantCount,
        champion_id: null,
        created_at: "2026-09-17T00:00:00Z",
      } as TierDraw);
      const idOf = (round: number, slot: number) => `${drawId}-r${round}s${slot}`;
      for (const m of plan.matches) {
        world.tier.push(
          tierRow(idOf(m.round, m.slot), drawId, m.round, m.slot, m.entrantAId, m.entrantBId, {
            winner_id: m.winnerId,
            is_bye: m.isBye,
            status: m.isBye ? "bye" : "scheduled",
            ...(m.round > 1
              ? { parent_a_id: idOf(m.round - 1, 2 * m.slot - 1), parent_b_id: idOf(m.round - 1, 2 * m.slot), }
              : {}),
          }),
        );
        created += m.isBye ? 0 : 1;
      }
    }
    event.drawsMade = true;
  }
  return created;
}

function generateStages(world: World, release: ReplayConfig["roundTwoRelease"]): number {
  let created = 0;
  for (const event of world.events) {
    if (event.real) {
      created += generateRealStages(world, event, release);
      continue;
    }
    const mine = world.placement.filter((m) => m.category_id === event.categoryId);
    const roundOne = mine.filter((m) => m.stage === "round1");
    const roundTwo = mine.filter((m) => m.stage === "round2");

    if (!event.roundTwoMade && roundOne.every((m) => m.status === "reported")) {
      const bySeed = (a: string, b: string) =>
        (event.seedOf.get(a) ?? 0) - (event.seedOf.get(b) ?? 0);
      const winners = event.entrantIds.filter((id) => event.record.get(id) === "W").sort(bySeed);
      const losers = event.entrantIds.filter((id) => event.record.get(id) === "L").sort(bySeed);
      let n = 0;
      for (const group of [winners, losers]) {
        for (let i = 0; i + 1 < group.length; i += 2) {
          world.placement.push(
            placementRow(
              `pm-${event.index}-2-${n}`,
              event.categoryId,
              "round2",
              group[i] as string,
              group[i + 1] as string,
            ),
          );
          n += 1;
          created += 1;
        }
      }
      event.roundTwoMade = true;
    }

    if (
      event.roundTwoMade &&
      !event.drawsMade &&
      roundTwo.length > 0 &&
      roundTwo.every((m) => m.status === "reported")
    ) {
      const tierOfRecord: Record<string, string> = { WW: "A", WL: "B", LW: "C", LL: "D" };
      for (const tier of ["A", "B", "C", "D"] as const) {
        const members = event.entrantIds.filter((id) => tierOfRecord[event.record.get(id) ?? ""] === tier);
        if (members.length < 2) continue;
        const plan = buildTierBracket(
          tier,
          members.map((id) => ({ id, seed: event.seedOf.get(id) ?? 0 })),
        );
        const drawId = `draw-${event.index}-${tier}`;
        world.draws.push({
          id: drawId,
          tournament_id: TOURNAMENT_ID,
          category_id: event.categoryId,
          tier,
          bracket_size: plan.bracketSize,
          entrant_count: plan.entrantCount,
          champion_id: null,
          created_at: "2026-09-17T00:00:00Z",
        } as TierDraw);
        const idOf = (round: number, slot: number) => `${drawId}-r${round}s${slot}`;
        for (const m of plan.matches) {
          world.tier.push(
            tierRow(idOf(m.round, m.slot), drawId, m.round, m.slot, m.entrantAId, m.entrantBId, {
              winner_id: m.winnerId,
              is_bye: m.isBye,
              status: m.isBye ? "bye" : "scheduled",
              ...(m.round > 1
                ? { parent_a_id: idOf(m.round - 1, 2 * m.slot - 1), parent_b_id: idOf(m.round - 1, 2 * m.slot) }
                : {}),
            }),
          );
          created += m.isBye ? 0 : 1;
        }
      }
      event.drawsMade = true;
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// The planner, as each strategy uses it
// ---------------------------------------------------------------------------

interface Ctx {
  world: World;
  config: ReplayConfig;
  clock: number;
  strategy: StrategyName;
  readyAt: Map<string, number>;
  timedAt: Map<string, number>;
  firstPublished: Map<string, number>;
  moves: { delta: number; aheadMs: number; courtChanged: boolean }[];
  startLateness: number[];
  actualStart: Map<string, number>;
  actualEnd: Map<string, number>;
  debug?: string[] | undefined;
  /** Audits recorded around each compaction, when asked for. */
  audit?: { before: ScheduleAudit; after: ScheduleAudit }[] | undefined;
  /** Called at each trigger with both plans computed from the same state, before one is applied. */
  probe?: ((sample: PackingSample) => void) | undefined;
  running: Map<string, { row: Row; end: number }>;
  counters: {
    falseFree: number;
    falseFreeMinutes: number;
    reflowPushes: number;
    reflowPushMinutes: number;
    gateRejections: number;
    manualPresses: number;
    failedApplies: number;
    planRuns: number;
    planMsTotal: number;
    planMsMax: number;
  };
}

function plan(
  ctx: Ctx,
  mode: "rebuild" | "place-ready",
  freezeHorizonMinutes?: number,
): PlacementSchedulePlan {
  const { world } = ctx;
  const started = performance.now();
  let result: PlacementSchedulePlan;
  try {
    result = planPlacementSchedule({
    mode,
    tournament: world.tournament,
    days: world.days,
    allCourts: world.courts,
    teams: world.teams,
    entrants: world.entrants,
    draws: world.draws,
    placementMatches: world.placement,
    tierMatches: world.tier,
    categoryOrder: ctx.config.flatCategoryOrder
      ? new Map([...world.categoryOrder.keys()].map((k) => [k, 0]))
      : world.categoryOrder,
    ...(ctx.config.plannerOptions ? { options: ctx.config.plannerOptions } : {}),
    now: ctx.clock,
    ...(freezeHorizonMinutes != null ? { freezeHorizonMinutes } : {}),
    });
  } catch (error) {
    if (ctx.debug) {
      const message = String((error as Error).message);
      const ids = [...message.matchAll(/(?:match|other)=([\w-]+)/g)].map((m) => m[1]);
      for (const row of rowsOf(world)) {
        if (ids.includes(row.id)) {
          ctx.debug.push(
            `ERR ${row.id} ${row.status} court=${row.court_id} sched=${row.scheduled_time} started=${row.started_at} ended=${row.ended_at} clock=${new Date(ctx.clock).toISOString()}`,
          );
        }
      }
    }
    throw error;
  }
  const elapsed = performance.now() - started;
  ctx.counters.planRuns += 1;
  ctx.counters.planMsTotal += elapsed;
  ctx.counters.planMsMax = Math.max(ctx.counters.planMsMax, elapsed);
  return result;
}

/** Counts courts whose next planned match starts before the match running on them really ends. */
function checkFalseFree(ctx: Ctx) {
  for (const { row, end } of ctx.running.values()) {
    if (!row.court_id) continue;
    const next = rowsOf(ctx.world)
      .filter((r) => r.court_id === row.court_id && r.status === "scheduled" && r.scheduled_time)
      .sort((a, b) => Date.parse(a.scheduled_time as string) - Date.parse(b.scheduled_time as string))[0];
    if (next && Date.parse(next.scheduled_time as string) < end) {
      ctx.counters.falseFree += 1;
      ctx.counters.falseFreeMinutes += (end - Date.parse(next.scheduled_time as string)) / MINUTE;
    }
  }
}

function trackTimed(ctx: Ctx) {
  for (const row of rowsOf(ctx.world)) {
    if (row.scheduled_time && !ctx.timedAt.has(row.id)) {
      ctx.timedAt.set(row.id, ctx.clock);
      ctx.firstPublished.set(row.id, Date.parse(row.scheduled_time));
    }
  }
}

function trackReady(ctx: Ctx) {
  for (const row of rowsOf(ctx.world)) {
    if (isLive(row) && isReady(row) && !ctx.readyAt.has(row.id)) ctx.readyAt.set(row.id, ctx.clock);
  }
}

function recordMove(ctx: Ctx, before: { start: number; court: string | null }, row: Row) {
  const after = row.scheduled_time ? Date.parse(row.scheduled_time) : null;
  if (after == null) return;
  const delta = after - before.start;
  const courtChanged = before.court !== row.court_id;
  if (delta !== 0 || courtChanged) {
    ctx.moves.push({ delta, aheadMs: before.start - ctx.clock, courtChanged });
    if (ctx.debug && delta > 120 * MINUTE) {
      ctx.debug.push(
        `clock ${new Date(ctx.clock).toISOString().slice(5, 16)} ${row.id} ` +
          `${new Date(before.start).toISOString().slice(5, 16)} -> ${new Date(after).toISOString().slice(5, 16)}`,
      );
    }
  }
}

/** Mirrors `place_ready_matches`: fill only rows with neither court nor time. */
function applyPlaceReady(ctx: Ctx, built: PlacementSchedulePlan) {
  const byId = new Map(rowsOf(ctx.world).map((r) => [r.id, r]));
  for (const slot of [...built.placementNewPayload, ...built.knockoutNewPayload]) {
    const row = byId.get(slot.match_id);
    if (row && row.status === "scheduled" && !row.court_id && !row.scheduled_time) {
      row.court_id = slot.court_id;
      row.scheduled_time = slot.scheduled_time;
    }
  }
  trackTimed(ctx);
  checkFalseFree(ctx);
}

/** Mirrors `apply_placement_day_schedule`: clear every scheduled row, then set the payload. */
function applyRebuild(ctx: Ctx, built: PlacementSchedulePlan): boolean {
  if (built.blocked.length > 0) {
    ctx.counters.failedApplies += 1;
    return false;
  }
  const rows = rowsOf(ctx.world).filter((r) => r.status === "scheduled" && isLive(r));
  const before = new Map(
    rows
      .filter((r) => r.scheduled_time && r.court_id)
      .map((r) => [r.id, { start: Date.parse(r.scheduled_time as string), court: r.court_id }]),
  );
  const slots = new Map(
    [...built.placementSlotPayload, ...built.knockoutSlotPayload].map((s) => [s.match_id, s]),
  );
  for (const row of rows) {
    const slot = slots.get(row.id);
    row.scheduled_time = slot ? slot.scheduled_time : null;
    row.court_id = slot ? slot.court_id : null;
  }
  for (const row of rows) {
    const prior = before.get(row.id);
    if (prior) recordMove(ctx, prior, row);
  }
  trackTimed(ctx);
  checkFalseFree(ctx);
  return true;
}

/** True when a plan would postpone something starting soon by more than the gate allows. */
function gateRejects(ctx: Ctx, built: PlacementSchedulePlan): boolean {
  if (built.summary.overrun) return true;
  const { windowMinutes, maxPostponeMinutes } = ctx.config.gate;
  const byId = new Map(rowsOf(ctx.world).map((r) => [r.id, r]));
  for (const slot of [...built.placementSlotPayload, ...built.knockoutSlotPayload]) {
    const row = byId.get(slot.match_id);
    if (!row || row.status !== "scheduled" || !row.scheduled_time) continue;
    const old = Date.parse(row.scheduled_time);
    const next = Date.parse(slot.scheduled_time);
    if (old - ctx.clock <= windowMinutes * MINUTE && next - old > maxPostponeMinutes * MINUTE) return true;
  }
  return false;
}

function groupDone(world: World, row: Row): boolean {
  const same = rowsOf(world).filter((m) =>
    isTier(row) && isTier(m)
      ? m.draw_id === row.draw_id && m.round === row.round && !m.is_bye
      : !isTier(row) && !isTier(m) && m.category_id === row.category_id && m.stage === row.stage,
  );
  return same.length > 0 && same.every((m) => m.status === "reported");
}

export interface ScheduleAudit {
  /** Two matches on one court at once. */
  courtOverlaps: number;
  /** Two matches for one player closer together than the later match's rest gap. */
  restViolations: number;
  /** A knockout match starting before its feeders finished plus the rest gap. */
  feederViolations: number;
}

/**
 * Checks the planned schedule against the three rules a pull-forward could most easily break.
 *
 * Counts violations among matches that are timed and not yet reported, using planned lengths, so it
 * judges the schedule as published rather than how the day actually unfolded (the actual day has
 * reflow and jitter, which can erode rest in every strategy alike).
 */
export function auditSchedule(world: World, clock: number): ScheduleAudit {
  const live = rowsOf(world).filter(
    (r) => isLive(r) && (r.status === "scheduled" || r.status === "in-progress") && (r.scheduled_time || r.started_at),
  );
  const start = (r: Row) => Date.parse((r.status === "in-progress" ? r.started_at : r.scheduled_time) as string);
  const end = (r: Row) => start(r) + slotMinutes(world, r) * MINUTE;
  let courtOverlaps = 0;
  let restViolations = 0;
  let feederViolations = 0;
  for (let i = 0; i < live.length; i += 1) {
    const a = live[i] as Row;
    for (let j = i + 1; j < live.length; j += 1) {
      const b = live[j] as Row;
      const [first, second] = start(a) <= start(b) ? [a, b] : [b, a];
      if (a.court_id && a.court_id === b.court_id && start(a) < end(b) && start(b) < end(a)) {
        courtOverlaps += 1;
      }
      const shared = playersOf(world, a).some((p) => playersOf(world, b).includes(p));
      // Judged by the stricter of the planner's rule (the earlier match's gap) and the reflow's (the later's).
      const needed = Math.max(restMinutes(world, first), restMinutes(world, second)) * MINUTE;
      if (shared && start(second) < end(first) + needed) restViolations += 1;
    }
  }
  const byId = new Map(rowsOf(world).map((r) => [r.id, r]));
  for (const r of live) {
    if (!isTier(r) || r.status !== "scheduled") continue;
    for (const pid of [r.parent_a_id, r.parent_b_id]) {
      const parent = pid ? byId.get(pid) : undefined;
      if (parent?.ended_at && start(r) < Date.parse(parent.ended_at) + restMinutes(world, r) * MINUTE) {
        feederViolations += 1;
      }
    }
  }
  void clock;
  return { courtOverlaps, restViolations, feederViolations };
}

/**
 * Pulls every still-waiting match as early as it can legally go: a single left-compaction pass.
 *
 * The experiment behind `rebuild-leftshift`. The planner's plan leaves court gaps that a match planned
 * later could fill (see `docs/scheduling-strategy-evaluation.md`), so this walks the queue in time
 * order and moves each match to the earliest time at which some court is free, both sides' players
 * are free with their rest, and its feeders have finished. Nothing moves later, nothing crosses a
 * day, and a started match never moves.
 */
function leftShift(ctx: Ctx, options: { protectMinutes: number; minLeadMinutes: number } = { protectMinutes: 0, minLeadMinutes: 0 }) {
  const { world } = ctx;
  const dayStartOf = (ms: number) => {
    const d = new Date(ms);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const waiting = rowsOf(world)
    .filter((r) => r.status === "scheduled" && isLive(r) && isReady(r) && r.scheduled_time && r.court_id)
    // Anything starting sooner than the protected window is left alone, so a pull never changes a
    // time somebody is already getting ready for.
    .filter((r) => Date.parse(r.scheduled_time as string) - ctx.clock >= options.protectMinutes * MINUTE)
    .sort((a, b) => Date.parse(a.scheduled_time as string) - Date.parse(b.scheduled_time as string));
  const byId = new Map(rowsOf(world).map((r) => [r.id, r]));
  interface Busy { id: string; court: string | null; players: string[]; start: number; end: number; rest: number }
  const intervals = (excludeId: string): Busy[] =>
    rowsOf(world).flatMap((r) => {
      if (r.id === excludeId || !isLive(r) || r.status === "reported") return [];
      let start: number | null = null;
      if (r.status === "in-progress" && r.started_at) start = Date.parse(r.started_at);
      else if (r.status === "scheduled" && r.scheduled_time && r.court_id) start = Date.parse(r.scheduled_time);
      if (start == null) return [];
      const end = r.status === "in-progress"
        ? Math.max(ctx.clock, start + slotMinutes(world, r) * MINUTE)
        : start + slotMinutes(world, r) * MINUTE;
      return [{ id: r.id, court: r.court_id, players: playersOf(world, r), start, end, rest: restMinutes(world, r) * MINUTE }];
    });
  // A match is never pulled to less than the minimum notice from now.
  const floorMs = Math.ceil((ctx.clock + options.minLeadMinutes * MINUTE) / MINUTE) * MINUTE;

  for (const row of waiting) {
    const current = Date.parse(row.scheduled_time as string);
    const dur = slotMinutes(world, row) * MINUTE;
    const mine = playersOf(world, row);
    const rest = restMinutes(world, row) * MINUTE;
    const others = intervals(row.id);
    const dayFloor = Math.max(floorMs, dayStartOf(current));
    let parentFloor = 0;
    if (isTier(row)) {
      for (const pid of [row.parent_a_id, row.parent_b_id]) {
        const parent = pid ? byId.get(pid) : undefined;
        if (parent?.ended_at) parentFloor = Math.max(parentFloor, Date.parse(parent.ended_at) + rest);
      }
    }
    const lower = Math.max(dayFloor, parentFloor);
    const candidates = new Set<number>([lower]);
    for (const o of others) {
      if (o.end >= lower) candidates.add(o.end);
      if (o.end + rest >= lower) candidates.add(o.end + rest);
    }
    const ordered = [...candidates].filter((t) => t < current).sort((a, b) => a - b);
    for (const t of ordered) {
      // The planner's rule is the earlier match's `restAfter`; the live reflow's is the later match's
      // gap. They differ between stages (placement 20, knockout 30), so the stricter of the two is
      // used and the result is valid under both.
      const playersOk = !others.some((o) => {
        if (!o.players.some((p) => mine.includes(p))) return false;
        const gap = Math.max(rest, o.rest);
        return t < o.end + gap && t + dur + gap > o.start;
      });
      if (!playersOk) continue;
      const court = world.courts.find(
        (c) => !others.some((o) => o.court === c.id && t < o.end && t + dur > o.start),
      );
      if (!court) continue;
      const before = { start: current, court: row.court_id };
      row.scheduled_time = iso(t);
      row.court_id = court.id;
      recordMove(ctx, before, row);
      break;
    }
  }
}

/** What each strategy does after a result has been recorded and the next stage generated. */
function react(ctx: Ctx, finished: Row) {
  const missing = readyUnplacedCount(ctx.world.placement, ctx.world.tier) > 0;
  if (missing && ctx.probe) ctx.probe(measurePlans(ctx));
  switch (ctx.strategy) {
    case "place-ready": {
      if (!missing) return;
      applyPlaceReady(ctx, plan(ctx, "place-ready"));
      return;
    }
    case "rebuild": {
      if (!missing) return;
      applyRebuild(ctx, plan(ctx, "rebuild"));
      return;
    }
    case "rebuild-leftshift": {
      if (!missing) return;
      if (applyRebuild(ctx, plan(ctx, "rebuild"))) {
        const before = ctx.audit ? auditSchedule(ctx.world, ctx.clock) : null;
        leftShift(ctx);
        if (ctx.audit && before) ctx.audit.push({ before, after: auditSchedule(ctx.world, ctx.clock) });
      }
      return;
    }
    case "gated-leftshift": {
      if (!missing) return;
      const built = plan(ctx, "rebuild");
      if (built.blocked.length > 0 || built.summary.overrun) {
        ctx.counters.gateRejections += 1;
        return;
      }
      // Try the rebuild plus a compaction on a copy of the times, and keep it only if the result
      // postpones nothing starting soon by more than the gate allows.
      const rows = rowsOf(ctx.world);
      const saved = rows.map((r) => ({ r, t: r.scheduled_time, c: r.court_id }));
      const movesBefore = ctx.moves.length;
      const readyBefore = new Map(ctx.timedAt);
      if (!applyRebuild(ctx, built)) return;
      leftShift(ctx);
      const { windowMinutes, maxPostponeMinutes } = ctx.config.gate;
      const breach = ctx.moves.slice(movesBefore).some(
        (m) => m.aheadMs <= windowMinutes * MINUTE && m.delta > maxPostponeMinutes * MINUTE,
      );
      // `applyRebuild` records moves against the pre-plan times, and `leftShift` against the
      // post-plan times, so judge the net result against the saved times instead.
      const netBreach = saved.some(({ r, t }) => {
        if (!t || !r.scheduled_time || r.status !== "scheduled") return false;
        const old = Date.parse(t);
        return (
          old - ctx.clock <= windowMinutes * MINUTE &&
          Date.parse(r.scheduled_time) - old > maxPostponeMinutes * MINUTE
        );
      });
      if (breach || netBreach) {
        ctx.moves.length = movesBefore;
        for (const { r, t, c } of saved) {
          r.scheduled_time = t;
          r.court_id = c;
        }
        ctx.timedAt = readyBefore;
        ctx.counters.gateRejections += 1;
      }
      return;
    }
    case "future-days": {
      if (!missing) return;
      applyPlaceReady(ctx, plan(ctx, "place-ready"));
      // Today is left exactly as it is, since people are on court and about to be; every later day
      // is re-solved and compacted, since nobody has planned their evening around it yet.
      const closeToday = new Date(ctx.clock);
      const [hh, mm] = ctx.config.dayEnd.split(":").map(Number);
      closeToday.setHours(hh ?? 18, mm ?? 0, 0, 0);
      const untilClose = Math.max(0, (closeToday.getTime() - ctx.clock) / MINUTE);
      const built = plan(ctx, "rebuild", untilClose);
      if (built.blocked.length === 0 && !built.summary.overrun) {
        const saved = rowsOf(ctx.world).map((r) => ({ r, t: r.scheduled_time, c: r.court_id }));
        const movesBefore = ctx.moves.length;
        if (applyRebuild(ctx, built)) {
          leftShift(ctx, { protectMinutes: untilClose, minLeadMinutes: 60 });
          const end = (useCurrent: boolean) =>
            Math.max(
              0,
              ...saved
                .filter(({ r }) => r.status === "scheduled" && isLive(r))
                .map(({ r, t }) => {
                  const time = useCurrent ? r.scheduled_time : t;
                  return time ? Date.parse(time) + slotMinutes(ctx.world, r) * MINUTE : 0;
                }),
            );
          if (end(true) > end(false)) {
            ctx.moves.length = movesBefore;
            for (const { r, t, c } of saved) {
              r.scheduled_time = t;
              r.court_id = c;
            }
          }
        }
      }
      return;
    }
    case "rolling-horizon": {
      if (!missing) return;
      // Give the new matches a time at once, then re-solve only the tail: everything starting within
      // the horizon is pinned, so the people about to play never see a change, and what is further
      // out is treated as an estimate that may improve.
      applyPlaceReady(ctx, plan(ctx, "place-ready"));
      const horizon = ctx.config.compact.freezeMinutes;
      const built = plan(ctx, "rebuild", horizon);
      if (built.blocked.length === 0 && !built.summary.overrun) {
        const saved = rowsOf(ctx.world).map((r) => ({ r, t: r.scheduled_time, c: r.court_id }));
        const movesBefore = ctx.moves.length;
        if (applyRebuild(ctx, built)) {
          leftShift(ctx, { protectMinutes: horizon, minLeadMinutes: 60 });
          // Keep the tail change only if it does not finish the queue later than before.
          const end = (list: { r: Row; t: string | null }[], useCurrent: boolean) =>
            Math.max(
              0,
              ...list
                .filter(({ r }) => r.status === "scheduled" && isLive(r))
                .map(({ r, t }) => {
                  const time = useCurrent ? r.scheduled_time : t;
                  return time ? Date.parse(time) + slotMinutes(ctx.world, r) * MINUTE : 0;
                }),
            );
          if (end(saved, true) > end(saved, false)) {
            ctx.moves.length = movesBefore;
            for (const { r, t, c } of saved) {
              r.scheduled_time = t;
              r.court_id = c;
            }
          }
        }
      }
      return;
    }
    case "place-ready-pull": {
      if (!missing) return;
      applyPlaceReady(ctx, plan(ctx, "place-ready"));
      // Then pull later matches earlier into gaps, but never anything starting within 2 hours, and
      // never to less than an hour's notice. Nothing is ever pushed later.
      leftShift(ctx, { protectMinutes: 120, minLeadMinutes: 60 });
      return;
    }
    case "gated-rebuild": {
      if (!missing) return;
      const built = plan(ctx, "rebuild");
      if (gateRejects(ctx, built)) {
        ctx.counters.gateRejections += 1;
        return;
      }
      applyRebuild(ctx, built);
      return;
    }
    case "place-then-compact": {
      if (!missing) return;
      // First give every new match a time at once, without moving anything...
      applyPlaceReady(ctx, plan(ctx, "place-ready"));
      // ...then look at the whole queue once more, with everything starting soon pinned, and keep
      // the result only if it is gated-safe and finishes the queue meaningfully sooner.
      const horizon = ctx.config.compact.freezeMinutes;
      const built = plan(ctx, "rebuild", horizon);
      if (built.blocked.length > 0 || built.summary.overrun) return;
      const currentEnd = Math.max(
        0,
        ...rowsOf(ctx.world)
          .filter((r) => r.status === "scheduled" && r.scheduled_time)
          .map((r) => Date.parse(r.scheduled_time as string) + slotMinutes(ctx.world, r) * MINUTE),
      );
      const plannedEnd = built.summary.projectedFinish ? Date.parse(built.summary.projectedFinish) : currentEnd;
      if (gateRejects(ctx, built)) {
        ctx.counters.gateRejections += 1;
        return;
      }
      if (currentEnd - plannedEnd >= ctx.config.compact.minGainMinutes * MINUTE) applyRebuild(ctx, built);
      return;
    }
    case "manual-rounds": {
      if (!groupDone(ctx.world, finished)) return;
      applyRebuild(ctx, plan(ctx, "rebuild"));
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** The stand-in for the live reflow: later matches on a court never start before it frees up. */
function cascadeCourt(ctx: Ctx, courtId: string, freeAt: number, afterId: string) {
  const { world } = ctx;
  const queue = rowsOf(world)
    .filter((r) => r.court_id === courtId && r.status === "scheduled" && r.scheduled_time && r.id !== afterId)
    .sort((a, b) => Date.parse(a.scheduled_time as string) - Date.parse(b.scheduled_time as string));
  let prevEnd = freeAt;
  for (const row of queue) {
    let start = Date.parse(row.scheduled_time as string);
    if (start < prevEnd) {
      ctx.counters.reflowPushes += 1;
      ctx.counters.reflowPushMinutes += (prevEnd - start) / MINUTE;
      start = prevEnd;
      row.scheduled_time = iso(start);
    }
    prevEnd = start + slotMinutes(world, row) * MINUTE;
  }
}

export interface PackingStats {
  /** Matches still to be played that the plan gives a time. */
  queued: number;
  /** Minutes of play in them. */
  workMinutes: number;
  /** Minutes from now to the last planned end. */
  horizonMinutes: number;
  /** Unused court minutes between consecutive planned matches on one court on one day. */
  gapMinutes: number;
  /** Court minutes from now to the first planned match on each court (same day only). */
  leadingMinutes: number;
  /** The same, measured from when the PLANNER believes each court frees up (a running match = now + a slot). */
  leadingBelievedMinutes: number;
  /** Distinct days the queue touches. */
  days: number;
  /** Planned work divided by courts times horizon: 1 would be no idle court at all. */
  efficiency: number;
}

/** Why the first match on a court starts later than the court is free, counted across courts. */
export type LeadingCause = "frozen" | "player_limited" | "parent_limited" | "barrier" | "unexplained";

export interface PackingSample {
  /** What the Schedule page would suggest at this moment, with the cost stated; null when it would say nothing. */
  suggestion: RebuildSuggestion | null;
  /**
   * Court minutes the planner USED TO reserve beyond a running match's likely end, when it modelled every
   * running match as ending one full slot from NOW. Kept as a measure of that old behaviour; the planner now
   * uses `inProgressEnd`, so this no longer describes what it plans.
   */
  inProgressPhantomMinutes: number;
  rebuildCauses: Record<LeadingCause, number>;
  placeReadyCauses: Record<LeadingCause, number>;
  clockMs: number;
  readyUntimed: number;
  rebuild: PackingStats;
  placeReady: PackingStats;
}

/** When each court is next free: now, or when the match on it is expected to end. */
function courtFreeAt(ctx: Ctx): Map<string, number> {
  const free = new Map<string, number>(ctx.world.courts.map((c) => [c.id, ctx.clock]));
  for (const r of rowsOf(ctx.world)) {
    if (r.status === "in-progress" && r.started_at && r.court_id) {
      const end = Math.max(ctx.clock, Date.parse(r.started_at) + slotMinutes(ctx.world, r) * MINUTE);
      free.set(r.court_id, Math.max(free.get(r.court_id) ?? ctx.clock, end));
    }
  }
  return free;
}

function packingOf(
  ctx: Ctx,
  slots: readonly { matchId: string; courtId: string; startMs: number }[],
): PackingStats {
  const byId = new Map(rowsOf(ctx.world).map((r) => [r.id, r]));
  const intervals = slots.flatMap((s) => {
    const row = byId.get(s.matchId);
    return row ? [{ court: s.courtId, start: s.startMs, end: s.startMs + slotMinutes(ctx.world, row) * MINUTE }] : [];
  });
  const work = intervals.reduce((sum, i) => sum + (i.end - i.start), 0) / MINUTE;
  const lastEnd = Math.max(ctx.clock, ...intervals.map((i) => i.end));
  let gap = 0;
  const byCourt = new Map<string, typeof intervals>();
  for (const i of intervals) byCourt.set(i.court, [...(byCourt.get(i.court) ?? []), i]);
  for (const list of byCourt.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let k = 1; k < list.length; k += 1) {
      const prev = list[k - 1] as { end: number };
      const next = list[k] as { start: number };
      const sameDay = new Date(prev.end).toDateString() === new Date(next.start).toDateString();
      if (sameDay && next.start > prev.end) gap += (next.start - prev.end) / MINUTE;
    }
  }
  let leading = 0;
  const free = courtFreeAt(ctx);
  for (const [court, list] of byCourt) {
    const first = list[0] as { start: number };
    const from = free.get(court) ?? ctx.clock;
    if (new Date(first.start).toDateString() === new Date(from).toDateString() && first.start > from) {
      leading += (first.start - from) / MINUTE;
    }
  }
  let leadingBelieved = 0;
  const believed = new Map<string, number>(ctx.world.courts.map((c) => [c.id, ctx.clock]));
  for (const r of rowsOf(ctx.world)) {
    if (r.status === "in-progress" && r.court_id) {
      believed.set(
        r.court_id,
        inProgressEnd({
          start: Date.parse(r.started_at ?? r.scheduled_time ?? new Date(ctx.clock).toISOString()),
          slotMs: slotMinutes(ctx.world, r) * MINUTE,
          now: ctx.clock,
        }),
      );
    }
  }
  for (const [court, list] of byCourt) {
    const first = list[0] as { start: number };
    const from = believed.get(court) ?? ctx.clock;
    if (new Date(first.start).toDateString() === new Date(from).toDateString() && first.start > from) {
      leadingBelieved += (first.start - from) / MINUTE;
    }
  }
  const horizon = (lastEnd - ctx.clock) / MINUTE;
  return {
    leadingBelievedMinutes: leadingBelieved,
    leadingMinutes: leading,
    queued: intervals.length,
    workMinutes: work,
    horizonMinutes: horizon,
    gapMinutes: gap,
    days: new Set(intervals.map((i) => new Date(i.start).toDateString())).size,
    efficiency: horizon > 0 ? work / (ctx.world.courts.length * horizon) : 0,
  };
}

function leadingCauses(
  ctx: Ctx,
  slots: readonly { matchId: string; courtId: string; startMs: number }[],
  frozen: ReadonlySet<string>,
  placementUntimed: boolean,
): Record<LeadingCause, number> {
  const counts: Record<LeadingCause, number> = {
    frozen: 0,
    player_limited: 0,
    parent_limited: 0,
    barrier: 0,
    unexplained: 0,
  };
  const world = ctx.world;
  const byId = new Map(rowsOf(world).map((r) => [r.id, r]));
  // Every interval a player is busy for: matches on court now, and every planned match.
  const busy: { players: string[]; start: number; end: number; id: string; rest: number }[] = [];
  for (const r of rowsOf(world)) {
    if (r.status === "in-progress" && r.started_at) {
      const start = Date.parse(r.started_at);
      busy.push({
        id: r.id,
        players: playersOf(world, r),
        start,
        end: Math.max(ctx.clock, start + slotMinutes(world, r) * MINUTE),
        rest: restMinutes(world, r) * MINUTE,
      });
    }
  }
  for (const s of slots) {
    const r = byId.get(s.matchId);
    if (r) {
      busy.push({
        id: r.id,
        players: playersOf(world, r),
        start: s.startMs,
        end: s.startMs + slotMinutes(world, r) * MINUTE,
        rest: restMinutes(world, r) * MINUTE,
      });
    }
  }
  const firstPerCourt = new Map<string, { matchId: string; startMs: number }>();
  for (const s of slots) {
    const cur = firstPerCourt.get(s.courtId);
    if (!cur || s.startMs < cur.startMs) firstPerCourt.set(s.courtId, s);
  }
  const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
  const free = courtFreeAt(ctx);
  for (const [court, first] of firstPerCourt) {
    const from = free.get(court) ?? ctx.clock;
    if (first.startMs <= from + MINUTE || !sameDay(first.startMs, from)) continue;
    const row = byId.get(first.matchId);
    if (!row) continue;
    if (frozen.has(first.matchId)) {
      counts.frozen += 1;
      continue;
    }
    const mine = playersOf(world, row);
    const playerFloor = Math.max(
      0,
      ...busy
        .filter((b) => b.id !== row.id && b.end <= first.startMs && b.players.some((p) => mine.includes(p)))
        .map((b) => b.end + restMinutes(world, row) * MINUTE),
    );
    if (playerFloor >= first.startMs - MINUTE) {
      counts.player_limited += 1;
      continue;
    }
    if (isTier(row)) {
      const parents = [row.parent_a_id, row.parent_b_id]
        .map((id) => (id ? byId.get(id) : undefined))
        .flatMap((p) => (p?.ended_at ? [Date.parse(p.ended_at) + restMinutes(world, row) * MINUTE] : []));
      if (parents.length && Math.max(...parents) >= first.startMs - MINUTE) {
        counts.parent_limited += 1;
        continue;
      }
      if (placementUntimed) {
        counts.barrier += 1;
        continue;
      }
    }
    counts.unexplained += 1;
    if (ctx.debug) {
      const gapStart = from;
      const gapEnd = first.startMs;
      // Matches planned later that could have used this gap: ready, players free, parents played.
      const fillers = slots.filter((o) => {
        const orow = byId.get(o.matchId);
        if (!orow || o.matchId === first.matchId || o.startMs < gapEnd) return false;
        const op = playersOf(world, orow);
        const clash = busy.some(
          (b) => b.id !== orow.id && b.players.some((p) => op.includes(p)) && b.start < gapStart + slotMinutes(world, orow) * MINUTE && b.end + restMinutes(world, orow) * MINUTE > gapStart,
        );
        return !clash && isReady(orow);
      });
      ctx.debug.push(
        `GAP ${court} ${new Date(gapStart).toTimeString().slice(0, 5)}-${new Date(gapEnd).toTimeString().slice(0, 5)} ` +
          `first=${first.matchId} kind=${isTier(row) ? "tier-r" + row.round : "placement-" + row.stage} ` +
          `fillers=${fillers.length} queued=${slots.length}`,
      );
    }
  }
  return counts;
}

/** Computes the rebuild plan and the place-ready plan from the current state, applying neither. */
function measurePlans(ctx: Ctx): PackingSample {
  const rebuild = plan(ctx, "rebuild");
  const placeReady = plan(ctx, "place-ready");
  const rebuildSlots = [...rebuild.placementSlotPayload, ...rebuild.knockoutSlotPayload].map((s) => ({
    matchId: s.match_id,
    courtId: s.court_id,
    startMs: Date.parse(s.scheduled_time),
  }));
  const placed = new Set(
    [...placeReady.placementNewPayload, ...placeReady.knockoutNewPayload].map((s) => s.match_id),
  );
  const keep = rowsOf(ctx.world)
    .filter((r) => r.status === "scheduled" && isLive(r) && r.court_id && r.scheduled_time && !placed.has(r.id))
    .map((r) => ({ matchId: r.id, courtId: r.court_id as string, startMs: Date.parse(r.scheduled_time as string) }));
  const added = [...placeReady.placementNewPayload, ...placeReady.knockoutNewPayload].map((s) => ({
    matchId: s.match_id,
    courtId: s.court_id,
    startMs: Date.parse(s.scheduled_time),
  }));
  const placementUntimed = ctx.world.placement.some(
    (m) => m.status === "scheduled" && !m.scheduled_time && m.entrant_a_id && m.entrant_b_id,
  );
  let phantom = 0;
  for (const r of rowsOf(ctx.world)) {
    if (r.status === "in-progress" && r.started_at && r.court_id) {
      const elapsed = (ctx.clock - Date.parse(r.started_at)) / MINUTE;
      phantom += Math.max(0, Math.min(elapsed, slotMinutes(ctx.world, r)));
    }
  }
  // The suggestion, judged as the page judges it: latest end among matches still to play, before and after.
  const endOf = (r: Row, startMs: number) => startMs + slotMinutes(ctx.world, r) * MINUTE;
  const rowsById = new Map(rowsOf(ctx.world).map((r) => [r.id, r]));
  const running = rowsOf(ctx.world).filter((r) => r.status === "in-progress" && r.started_at);
  const runningEnd = Math.max(
    0,
    ...running.map((r) => inProgressEnd({ start: Date.parse(r.started_at as string), slotMs: slotMinutes(ctx.world, r) * MINUTE, now: ctx.clock })),
  );
  const currentFinish =
    Math.max(
      runningEnd,
      ...rowsOf(ctx.world)
        .filter((r) => r.status === "scheduled" && isLive(r) && r.scheduled_time)
        .map((r) => endOf(r, Date.parse(r.scheduled_time as string))),
    ) || null;
  const plannedFinish =
    Math.max(
      runningEnd,
      ...rebuildSlots.flatMap((s) => {
        const r = rowsById.get(s.matchId);
        return r ? [endOf(r, s.startMs)] : [];
      }),
    ) || null;
  const suggestion = buildRebuildSuggestion({
    currentFinishMs: currentFinish,
    plannedFinishMs: plannedFinish,
    blockedCount: rebuild.blocked.length,
    diff: rebuild.diff,
    now: ctx.clock,
  });
  return {
    suggestion,
    inProgressPhantomMinutes: phantom,
    rebuildCauses: leadingCauses(ctx, rebuildSlots, new Set(rebuild.frozenMatchIds), placementUntimed),
    placeReadyCauses: leadingCauses(ctx, [...keep, ...added], new Set(placeReady.frozenMatchIds), placementUntimed),
    clockMs: ctx.clock,
    readyUntimed: readyUnplacedCount(ctx.world.placement, ctx.world.tier),
    rebuild: packingOf(ctx, rebuildSlots),
    placeReady: packingOf(ctx, [...keep, ...added]),
  };
}

export function runReplay(
  strategy: StrategyName,
  config: ReplayConfig = DEFAULT_CONFIG,
  timeline?: TimelineEntry[],
  debug?: string[],
  probe?: (sample: PackingSample) => void,
  audit?: { before: ScheduleAudit; after: ScheduleAudit }[],
): ReplayMetrics {
  const world = buildWorld(config);
  const dayStart = new Date(`${DAY_ONE}T09:00:00`).getTime();
  const ctx: Ctx = {
    world,
    config,
    clock: dayStart,
    strategy,
    readyAt: new Map(),
    timedAt: new Map(),
    firstPublished: new Map(),
    moves: [],
    startLateness: [],
    actualStart: new Map(),
    actualEnd: new Map(),
    debug,
    probe,
    audit,
    running: new Map(),
    counters: {
      falseFree: 0,
      falseFreeMinutes: 0,
      reflowPushes: 0,
      reflowPushMinutes: 0,
      gateRejections: 0,
      manualPresses: 0,
      failedApplies: 0,
      planRuns: 0,
      planMsTotal: 0,
      planMsMax: 0,
    },
  };
  // Dice for match lengths come from their own stream so a strategy that plays matches in a
  // different order still sees the same length for the same match.
  const lengthDice = (id: string) => mulberry32(config.seed * 7919 + [...id].reduce((a, c) => a + c.charCodeAt(0) * 31, 0))();
  const outcomeDice = (id: string) => {
    let hash = config.seed;
    for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    return mulberry32(hash)() < 0.5;
  };

  trackReady(ctx);
  applyRebuild(ctx, plan(ctx, "rebuild"));

  const running = ctx.running;
  let stuck = false;

  for (let guard = 0; guard < 5000; guard += 1) {
    // The next start on each court, held back by a player still on another court.
    let nextStart: { row: Row; at: number } | null = null;
    const byRowId = new Map(rowsOf(world).map((r) => [r.id, r]));
    // A match with prerequisites (the held entrant's second make-up) may not start until they are done:
    // blocked while one has not started, and waiting for the end of one still on court.
    const prerequisiteFloor = (r: Row): number | null => {
      if (isTier(r)) return 0;
      let floor = 0;
      for (const pid of r.prerequisite_ids ?? []) {
        const pre = byRowId.get(pid);
        if (!pre || pre.status === "reported" || pre.status === "walkover") continue;
        const live = running.get(pid);
        if (!live) return null;
        floor = Math.max(floor, live.end);
      }
      return floor;
    };
    for (const court of world.courts) {
      const queue = rowsOf(world)
        .filter((r) => r.court_id === court.id && r.status === "scheduled" && r.scheduled_time && isReady(r))
        .sort((a, b) => Date.parse(a.scheduled_time as string) - Date.parse(b.scheduled_time as string));
      let next: Row | undefined;
      let gate = 0;
      for (const candidate of queue) {
        const floor = prerequisiteFloor(candidate);
        if (floor != null) {
          next = candidate;
          gate = floor;
          break;
        }
      }
      if (!next) continue;
      let at = Math.max(Date.parse(next.scheduled_time as string), ctx.clock, gate);
      for (const { row, end } of running.values()) {
        const sharesCourt = row.court_id === court.id;
        const sharesPlayer = playersOf(world, row).some((p) => playersOf(world, next).includes(p));
        if (sharesCourt || sharesPlayer) at = Math.max(at, end);
      }
      if (!nextStart || at < nextStart.at) nextStart = { row: next, at };
    }
    const nextEnd = [...running.values()].sort((a, b) => a.end - b.end)[0];

    if (!nextStart && !nextEnd) {
      const unfinished = rowsOf(world).some((r) => isLive(r) && r.status !== "reported");
      if (!unfinished) break;
      // Nothing can run: the organiser would have to step in. Count it and rebuild once.
      if (readyUnplacedCount(world.placement, world.tier) > 0) {
        ctx.counters.manualPresses += 1;
        const built = plan(ctx, "rebuild");
        if (!applyRebuild(ctx, { ...built, blocked: [] })) {
          stuck = true;
          break;
        }
        continue;
      }
      stuck = true;
      break;
    }

    if (nextEnd && (!nextStart || nextEnd.end <= nextStart.at)) {
      // END
      const { row, end } = nextEnd;
      running.delete(row.id);
      ctx.clock = Math.max(ctx.clock, end);
      row.status = "reported";
      row.ended_at = iso(end);
      row.reported_time = iso(end);
      ctx.actualEnd.set(row.id, end);
      if (timeline && row.court_id) {
        timeline.push({
          id: row.id,
          court: row.court_id,
          start: ctx.actualStart.get(row.id) as number,
          end,
          players: playersOf(world, row),
        });
      }
      const aWins = config.pairedOutcomes ? outcomeDice(row.id) : winnerOf(world);
      row.winner_id = aWins ? row.entrant_a_id : row.entrant_b_id;
      if (isTier(row)) {
        const child = childSlot(row.slot);
        const target = world.tier.find(
          (m) => m.draw_id === row.draw_id && m.round === row.round + 1 && m.slot === child.slot,
        );
        if (target && row.winner_id) {
          if (child.side === "a") target.entrant_a_id = row.winner_id;
          else target.entrant_b_id = row.winner_id;
        }
      } else if (row.entrant_a_id && row.entrant_b_id) {
        const event = world.events.find((e) => e.categoryId === row.category_id) as EventState;
        const loser = aWins ? row.entrant_b_id : row.entrant_a_id;
        const winner = aWins ? row.entrant_a_id : row.entrant_b_id;
        // Round one sets the first letter of the record and round two appends the second.
        for (const [id, result] of [[winner, "W"], [loser, "L"]] as const) {
          event.record.set(id, row.stage === "round1" ? result : `${event.record.get(id) ?? ""}${result}`);
        }
      }
      if (row.court_id) cascadeCourt(ctx, row.court_id, end, row.id);
      generateStages(world, config.roundTwoRelease);
      trackReady(ctx);
      react(ctx, row);
    } else if (nextStart) {
      // START
      const { row, at } = nextStart;
      ctx.clock = Math.max(ctx.clock, at);
      const published = Date.parse(row.scheduled_time as string);
      ctx.startLateness.push((at - published) / MINUTE);
      row.status = "in-progress";
      row.started_at = iso(at);
      ctx.actualStart.set(row.id, at);
      const slot = slotMinutes(world, row);
      const length = config.jitterFraction
        ? Math.max(
            1,
            slot * (1 + config.jitterFraction.min + lengthDice(row.id) * (config.jitterFraction.max - config.jitterFraction.min)),
          )
        : Math.max(
            10,
            slot + config.jitterMinutes.min + lengthDice(row.id) * (config.jitterMinutes.max - config.jitterMinutes.min),
          );
      running.set(row.id, { row, end: Math.round(at + length * MINUTE) });
      if (row.court_id) cascadeCourt(ctx, row.court_id, at + slotMinutes(world, row) * MINUTE, row.id);
    }
  }

  return summarise(ctx, strategy, stuck);
}

function summarise(ctx: Ctx, strategy: StrategyName, stuck: boolean): ReplayMetrics {
  const { world } = ctx;
  const played = rowsOf(world).filter((r) => isLive(r) && ctx.actualEnd.has(r.id));
  const finishMs = Math.max(0, ...played.map((r) => ctx.actualEnd.get(r.id) as number));
  const close = new Date(`${dayDate(ctx.config.dayCount - 1)}T${ctx.config.dayEnd}`).getTime();

  // Court idle: within each court-day, the span from first start to last end minus the time played.
  let idle = 0;
  const byCourtDay = new Map<string, Row[]>();
  for (const r of played) {
    const key = `${r.court_id}|${new Date(ctx.actualStart.get(r.id) as number).toDateString()}`;
    byCourtDay.set(key, [...(byCourtDay.get(key) ?? []), r]);
  }
  for (const list of byCourtDay.values()) {
    const first = Math.min(...list.map((r) => ctx.actualStart.get(r.id) as number));
    const last = Math.max(...list.map((r) => ctx.actualEnd.get(r.id) as number));
    const busy = list.reduce(
      (sum, r) => sum + (ctx.actualEnd.get(r.id) as number) - (ctx.actualStart.get(r.id) as number),
      0,
    );
    idle += (last - first - busy) / MINUTE;
  }

  // Player waits: the gap between consecutive matches on the same day beyond the required rest.
  const waits: number[] = [];
  const byPlayer = new Map<string, Row[]>();
  for (const r of played) {
    for (const p of playersOf(world, r)) byPlayer.set(p, [...(byPlayer.get(p) ?? []), r]);
  }
  for (const list of byPlayer.values()) {
    list.sort((a, b) => (ctx.actualStart.get(a.id) as number) - (ctx.actualStart.get(b.id) as number));
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1] as Row;
      const next = list[i] as Row;
      const prevEnd = ctx.actualEnd.get(prev.id) as number;
      const nextStart = ctx.actualStart.get(next.id) as number;
      if (new Date(prevEnd).toDateString() !== new Date(nextStart).toDateString()) continue;
      waits.push(Math.max(0, (nextStart - prevEnd) / MINUTE - restMinutes(world, next)));
    }
  }

  const later = ctx.moves.filter((m) => m.delta > 0);
  const latencies = [...ctx.readyAt.entries()].flatMap(([id, ready]) => {
    const timed = ctx.timedAt.get(id);
    return timed == null ? [] : [(timed - ready) / MINUTE];
  });
  const delays = played.flatMap((r) => {
    const first = ctx.firstPublished.get(r.id);
    const start = ctx.actualStart.get(r.id);
    return first == null || start == null ? [] : [(start - first) / MINUTE];
  });
  const origin = new Date(`${DAY_ONE}T09:00:00`).getTime();
  const within = (ms: number) => ctx.moves.filter((m) => m.aheadMs <= ms).length;

  return {
    strategy,
    seed: ctx.config.seed,
    matches: played.length,
    finishMs,
    overrunMinutes: Math.max(0, (finishMs - close) / MINUTE),
    courtIdleMinutes: idle,
    waitSumMinutes: waits.reduce((a, b) => a + b, 0),
    waitP95Minutes: quantile(waits, 0.95),
    waitMaxMinutes: Math.max(0, ...waits),
    postponements: later.length,
    postponeSumMinutes: later.reduce((a, m) => a + m.delta / MINUTE, 0),
    postponeMaxMinutes: Math.max(0, ...later.map((m) => m.delta / MINUTE)),
    advancements: ctx.moves.filter((m) => m.delta < 0).length,
    changesWithin60: within(60 * MINUTE),
    changesWithin30: within(30 * MINUTE),
    postponementsWithin60: later.filter((m) => m.aheadMs <= 60 * MINUTE).length,
    delayVsFirstMeanMinutes: mean(delays),
    delayVsFirstP95Minutes: quantile(delays, 0.95),
    startedLate30Share: delays.length ? delays.filter((d) => d >= 30).length / delays.length : 0,
    lastEndMinutes: (finishMs - origin) / MINUTE,
    gateBreaches: later.filter(
      (m) =>
        m.aheadMs <= ctx.config.gate.windowMinutes * MINUTE &&
        m.delta > ctx.config.gate.maxPostponeMinutes * MINUTE,
    ).length,
    readyToTimedMeanMinutes: mean(latencies),
    readyToTimedP95Minutes: quantile(latencies, 0.95),
    startLatenessMeanMinutes: mean(ctx.startLateness),
    startLatenessP95Minutes: quantile(ctx.startLateness, 0.95),
    gateRejections: ctx.counters.gateRejections,
    falseFree: ctx.counters.falseFree,
    falseFreeMinutes: ctx.counters.falseFreeMinutes,
    reflowPushes: ctx.counters.reflowPushes,
    reflowPushMinutes: ctx.counters.reflowPushMinutes,
    manualPresses: ctx.counters.manualPresses,
    failedApplies: ctx.counters.failedApplies,
    planRuns: ctx.counters.planRuns,
    planMsTotal: ctx.counters.planMsTotal,
    planMsMax: ctx.counters.planMsMax,
    stuck,
  };
}

export interface TimelineEntry {
  id: string;
  court: string;
  start: number;
  end: number;
  players: string[];
}

/** Every clash on a court or for a player in the actual timeline: a replay must never have one. */
export function findOverlaps(timeline: readonly TimelineEntry[]): string[] {
  const problems: string[] = [];
  const byCourt = new Map<string, TimelineEntry[]>();
  const byPlayer = new Map<string, TimelineEntry[]>();
  for (const m of timeline) {
    byCourt.set(m.court, [...(byCourt.get(m.court) ?? []), m]);
    for (const p of m.players) byPlayer.set(p, [...(byPlayer.get(p) ?? []), m]);
  }
  for (const [kind, groups] of [
    ["court", byCourt],
    ["player", byPlayer],
  ] as const) {
    for (const [key, list] of groups) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i += 1) {
        const prev = list[i - 1] as TimelineEntry;
        const next = list[i] as TimelineEntry;
        if (next.start < prev.end) problems.push(`${kind} ${key}: ${prev.id} overlaps ${next.id}`);
      }
    }
  }
  return problems;
}
