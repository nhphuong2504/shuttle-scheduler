/**
 * Finish estimation: "when does this tournament actually finish?"
 *
 * The planner answers "where does every match that exists go?"; this module answers the desk's
 * real question, which is strictly larger. The gap between the two is the whole point:
 *
 *   * placed matches      — already on a court, and the floor of any forecast
 *   * unplaced/blocked    — a row with players that the planner could not place
 *   * awaiting-row        — an existing knockout row whose two sides are not decided yet
 *   * uncreated matches   — placement round two, and knockout rounds, that a finished tournament
 *                           must contain but which no row describes yet
 *
 * It is pure and read-only. Nothing here writes a slot, a payload, a `blocked` list, a draw row or
 * any database state; the estimates it returns are the only output. It reuses the real planner's
 * day loop through `runPlanDays`, so it is constrained by exactly the same courts, breaks, day
 * windows, rest gaps, feeder dependencies and stage barrier as a real build.
 *
 * ---------------------------------------------------------------------------------------------
 * What this module relies on in the scheduling core (verified against the current engine)
 * ---------------------------------------------------------------------------------------------
 *
 * Precedence is `ScheduleMatch.dependencies` and nothing else. `dependenciesSatisfied` refuses a
 * start until every dependency has a *known end* at or before that start (`knownEndOf`), and
 * `lowerBoundOf` raises a dependent's earliest start to the dependency's end. A dependency that is
 * neither in the problem nor an anchor is a preflight error (`unknown-dependency`), so a synthetic
 * item must only name feeders that are themselves in the forecast batch. The dependency gate takes
 * the dependency's end with **no rest**.
 *
 * Rest is `relateToDecided` over a **shared participant**, in either direction, and it is the only
 * mechanism that adds minutes beyond a dependency's end. So the between-rounds rest gap is produced
 * by giving a feeder and its child one shared participant id: the feeder carries the winner's
 * placeholder as a participant, the child carries the same placeholder, and
 * `max(restAfterOf(feeder), restBeforeOf(child))` becomes the gap. Precedence is *never* left to
 * shared participants — two matches sharing a participant can legally sit back to back when the
 * rest gap is 0, so ordering is always `dependencies`.
 *
 * Byes are a round-one-only artifact. `buildSingleElimination`/`buildTierBracket` emit `bye: true`
 * rows only while building round one, `nextTierRound` sets `isBye: false` for every later round,
 * and SQL's `advance_tier_draw_locked` inserts the next round with `is_bye = false`. Therefore a
 * bye is only ever subtracted from round one's expected count: `expected(round 1) = bracketSize/2 -
 * byes`, and `expected(round r>1) = bracketSize / 2**r` with no bye term.
 */

import { MINUTE_MS, ProblemValidationError } from "@/lib/scheduling";

import type {
  Court,
  PlacementEntrant,
  PlacementMatch,
  Team,
  TierDraw,
  TierDrawMatch,
  Tournament,
  TournamentDay,
  TournamentDayBreak,
} from "./data";
import { runPlanDays, type PlanDaysResult } from "./scheduling/day-plan";
import type { DayOneSchedulerOptions } from "./scheduling/policy";
import {
  buildPlayerLookup,
  isFixed,
  placementItems,
  tierItems,
  type StageItem,
} from "./scheduling/stage-items";
import type { ScheduledSlot } from "./scheduling/types";

const MINUTE = MINUTE_MS;

/** Synthetic ids are namespaced so a forecast item is never mistaken for a real row. */
const SYNTHETIC_PREFIX = "est:";

export function isSyntheticId(id: string): boolean {
  return id.startsWith(SYNTHETIC_PREFIX);
}

/** The placeholder a match's winner "carries forward" into the next round. */
function winnerToken(matchId: string): string {
  return `${SYNTHETIC_PREFIX}winner:${matchId}`;
}

/** The placeholder for the entrant a bye advances without playing. */
function byeToken(matchId: string): string {
  return `${SYNTHETIC_PREFIX}bye:${matchId}`;
}

/** A fresh placeholder pair for a round-one slot that has no row at all. */
function freshTokens(scope: string, round: number, slot: number): string[] {
  return [
    `${SYNTHETIC_PREFIX}slot:${scope}:r${round}:m${slot}:a`,
    `${SYNTHETIC_PREFIX}slot:${scope}:r${round}:m${slot}:b`,
  ];
}

/** How the estimate was arrived at. Drives the wording, never a number. */
export type FinishBasis = "placed" | "projected" | "overflow" | "invalid";

/**
 * The answer to "when does this tournament finish?".
 *
 * `finish` is a clock time when one can be named honestly, and `null` when it cannot. `basis`
 * says which of the four honest cases applies:
 *
 *   * `placed`    — there is no remaining work; `finish === placedFinish`.
 *   * `projected` — remaining work exists and fits inside the configured windows.
 *   * `overflow`  — the configured windows cannot contain the work. `finish` names the wall-clock
 *                   extension when extending the last day is enough (`deficitMinutes` set), and is
 *                   `null` when matches still cannot be placed at all (`unplacedMatches` set).
 *   * `invalid`   — the rows as they stand are already an impossible court layout (two fixed
 *                   occupancies of one court at once), so no forecast can be simulated. Reported
 *                   rather than thrown: a forecast is a nicety and must never fail a build.
 */
export interface FinishEstimate {
  /** Forecast tournament end, ISO; null when it cannot be named. */
  finish: string | null;
  /** Latest end among actually placed slots. The floor the forecast can never precede. */
  placedFinish: string | null;
  /** Existing, schedulable matches the forecast could not place at all. */
  unplacedMatches: number;
  /** Inevitable matches a finished tournament needs but no row exists for yet. */
  uncreatedMatches: number;
  /** Minutes the last day must be extended by, when extending is enough. */
  deficitMinutes: number | null;
  basis: FinishBasis;
  /** Forecast work still to place: unplaced + awaiting + uncreated. Display only. */
  remainingMatches: number;
  /** Configured days that actually have courts. Display only ("Cannot finish in N days"). */
  days: number;
}

// ---------------------------------------------------------------------------------------------
// Round arithmetic
// ---------------------------------------------------------------------------------------------

export interface RoundWorkloadInput {
  /** Power-of-two draw size. */
  bracketSize: number;
  /** Entrants actually in the draw. `byes = bracketSize - entrantCount`. */
  entrantCount: number;
  round: number;
  /** Rows that already exist in this round, byes and void rows excluded. */
  existingMatchesInRound: number;
}

/**
 * Expected matches in one knockout round, and how many of them have no row yet.
 *
 * Round one has `bracketSize/2` slots, of which `byes` are byes and therefore not matches to play,
 * so `expected = bracketSize/2 - byes`. Every later round has exactly half the previous round's
 * slots and never a bye (see the module docstring), so `expected = bracketSize / 2**round` with no
 * bye term — subtracting byes there is the classic double-count.
 */
export function roundWorkload(input: RoundWorkloadInput): { expected: number; synthetic: number } {
  const { bracketSize, entrantCount, round } = input;
  if (bracketSize <= 1 || entrantCount <= 1) return { expected: 0, synthetic: 0 };
  const byes = Math.max(0, bracketSize - entrantCount);
  const expected =
    round <= 1
      ? Math.max(0, Math.floor(bracketSize / 2) - byes)
      : Math.max(0, Math.floor(bracketSize / 2 ** round));
  return {
    expected,
    synthetic: Math.max(0, expected - Math.max(0, input.existingMatchesInRound)),
  };
}

/** The number of knockout rounds a draw of this size plays, or 0 for a champion-only draw. */
export function roundCount(bracketSize: number): number {
  if (bracketSize <= 1) return 0;
  return Math.round(Math.log2(bracketSize));
}

/**
 * Inevitable Placement Round 2 matches that no row describes yet.
 *
 * The format invariant is that every active entrant plays exactly two placement matches
 * (`src/lib/tournament/placement.ts:5-7`), so the whole stage is `N` matches and round one is
 * `floor(N/2)`, leaving `ceil(N/2)`. Small fields stop early: `N <= 1` plays nothing and `N === 2`
 * plays a single match with no round two, so both yield zero. Existing playable round-two rows are
 * subtracted, never the round-one rows.
 */
export function placementRoundTwoWorkload(input: {
  activeEntrants: number;
  existingRoundTwoMatches: number;
}): number {
  const expected = input.activeEntrants <= 2 ? 0 : Math.ceil(input.activeEntrants / 2);
  return Math.max(0, expected - Math.max(0, input.existingRoundTwoMatches));
}

/**
 * Inevitable knockout matches that no row describes yet, across every draw.
 *
 * A draw with a champion is finished and a one-entrant draw has nothing to play, so both are
 * skipped, exactly as the estimator's own item builder skips them. The per-round arithmetic stays
 * in `roundWorkload` and the `is_bye`-is-round-one-only invariant stays in the module docstring, so
 * any caller that needs the count cannot drift from the forecast.
 */
export function knockoutUncreatedMatches(input: {
  draws: readonly TierDraw[];
  tierMatches: readonly TierDrawMatch[];
}): number {
  let total = 0;
  for (const draw of input.draws) {
    if (draw.champion_id != null || draw.bracket_size <= 1 || draw.entrant_count <= 1) continue;
    const rounds = roundCount(draw.bracket_size);
    for (let round = 1; round <= rounds; round += 1) {
      const existingMatchesInRound = input.tierMatches.filter(
        (row) =>
          row.draw_id === draw.id && row.round === round && !row.is_bye && row.status !== "void",
      ).length;
      total += roundWorkload({
        bracketSize: draw.bracket_size,
        entrantCount: draw.entrant_count,
        round,
        existingMatchesInRound,
      }).synthetic;
    }
  }
  return total;
}

/** Slots physically present in a knockout round, byes included. */
function slotsInRound(bracketSize: number, round: number): number {
  return round <= 1 ? Math.floor(bracketSize / 2) : Math.floor(bracketSize / 2 ** round);
}

// ---------------------------------------------------------------------------------------------
// Forecast item construction
// ---------------------------------------------------------------------------------------------

interface ForecastItemsResult {
  items: StageItem[];
  /** Missing rows synthesized for this block. */
  uncreatedMatches: number;
}

/**
 * A synthetic knockout item.
 *
 * `entrantTokens` are the feeders' winner placeholders (empty for a round-one slot). Whatever the
 * entrants are, the item also carries **its own** winner placeholder: that is the only way its
 * child can share a participant with it, and sharing a participant is what makes
 * `relateToDecided` add the between-rounds rest gap. The dependency list alone carries precedence
 * with no rest, so both are needed.
 */
function syntheticItem(input: {
  id: string;
  categoryId: string;
  entrantTokens: string[];
  dependencies: string[];
  /**
   * Earliest start, for when the feeder is already pinned on another day.
   *
   * A dependency can only name a match the day's problem knows about, so a feeder that is
   * already placed (or is a real row still to be placed but pinned) cannot be a dependency
   * when the child is first attempted on an earlier day. Its end is folded into the child's
   * floor instead, which keeps the ordering without making the problem invalid.
   */
  eligibleFrom?: number | undefined;
  round: number;
  slot: number;
  slotMinutes: number;
  restGap: number;
  softOrder: number;
}): StageItem {
  const entrants = input.entrantTokens.length
    ? input.entrantTokens
    : freshTokens(input.id, input.round, input.slot);
  return {
    id: input.id,
    categoryId: input.categoryId,
    participantIds: [...entrants, winnerToken(input.id)],
    participantsKnown: true,
    durationMinutes: input.slotMinutes,
    restAfterMinutes: input.restGap,
    groupKey: input.categoryId,
    sequence: input.round * 100 + input.slot,
    softOrder: input.softOrder,
    ...(input.dependencies.length ? { dependencies: input.dependencies } : {}),
    ...(input.eligibleFrom == null ? {} : { eligibleFrom: input.eligibleFrom }),
  };
}

/**
 * `end` of an item the forecast cannot move: a played row (fixed with a real window) or a slot the
 * planner is already holding. `undefined` for anything still movable.
 */
function pinnedEndOf(
  id: string,
  pinById: ReadonlyMap<string, Pin>,
  itemById: ReadonlyMap<string, StageItem>,
): number | undefined {
  const pin = pinById.get(id);
  if (pin) return pin.end;
  const item = itemById.get(id);
  return item?.fixed === true && item.end != null ? item.end : undefined;
}

/**
 * Feeder ids a dependency may safely name: the ones the forecast can still move.
 *
 * A pinned feeder is folded into the child's `eligibleFrom` instead. Naming it as a dependency
 * would be an unknown-dependency on any day before the one it already sits on, which refuses the
 * whole forecast rather than deferring the child to the right day.
 */
function movableFeeders(
  ids: readonly string[],
  pinById: ReadonlyMap<string, Pin>,
  itemById: ReadonlyMap<string, StageItem>,
): string[] {
  return ids.filter((id) => pinnedEndOf(id, pinById, itemById) == null);
}

/** The child's floor when its feeders are pinned: their latest end plus the between-matches rest. */
function eligibleFromFeeders(
  ids: readonly string[],
  pinById: ReadonlyMap<string, Pin>,
  itemById: ReadonlyMap<string, StageItem>,
  restGap: number,
): number | undefined {
  let latest = 0;
  for (const id of ids) {
    const end = pinnedEndOf(id, pinById, itemById);
    if (end != null) latest = Math.max(latest, end + restGap * MINUTE);
  }
  return latest > 0 ? latest : undefined;
}

/**
 * Every knockout fixture the rest of the tournament will need: the rows that already exist (once
 * each, decided or not) plus one synthetic item per missing slot.
 *
 * Feeders come from the row's `parent_a_id`/`parent_b_id` when it has them, and from the two
 * previous-round slots otherwise. A feeder is only named as a dependency when it is itself in this
 * batch — naming a bye or a missing row would be an `unknown-dependency`, and a bye needs no wait.
 * The child still *carries* the feeder's winner placeholder as a participant so the between-rounds
 * rest gap is enforced by `relateToDecided`, which the dependency alone does not provide.
 *
 * The per-round synthetic count comes from `roundWorkload`, so the arithmetic has one home even
 * though the emission below walks slots.
 */
export function buildTierForecastItems(input: {
  draws: readonly TierDraw[];
  tierMatches: readonly TierDrawMatch[];
  /** The production planner's decided knockout items, reused so nothing is rebuilt. */
  productionItems: readonly StageItem[];
  /** Slots the plan is already holding, so a pinned feeder is a floor rather than a dependency. */
  pinById: ReadonlyMap<string, Pin>;
  drawCategory: ReadonlyMap<string, string>;
  categoryOrder: ReadonlyMap<string, number>;
  slotMinutes: number;
  restGap: number;
}): ForecastItemsResult {
  const productionById = new Map(input.productionItems.map((item) => [item.id, item]));
  const rowsByDraw = new Map<string, TierDrawMatch[]>();
  for (const row of input.tierMatches) {
    const list = rowsByDraw.get(row.draw_id) ?? [];
    list.push(row);
    rowsByDraw.set(row.draw_id, list);
  }

  const items: StageItem[] = [];
  let uncreatedMatches = 0;

  for (const draw of input.draws) {
    // A draw with a champion is finished; a one-entrant draw has no matches to play.
    if (draw.champion_id != null) continue;
    if (draw.bracket_size <= 1 || draw.entrant_count <= 1) continue;

    const rounds = roundCount(draw.bracket_size);
    if (rounds <= 0) continue;
    const rows = rowsByDraw.get(draw.id) ?? [];
    const categoryId = input.drawCategory.get(draw.id) ?? draw.category_id;
    const softOrder = input.categoryOrder.get(categoryId) ?? 0;

    const rowAt = new Map<string, TierDrawMatch>();
    for (const row of rows) {
      // A void row is not a match; treat its slot as absent so the slot is re-derived, never
      // scheduled as the cancelled row.
      if (row.status === "void") continue;
      rowAt.set(`${row.round}|${row.slot}`, row);
    }

    // Per-slot state carried forward: the playable item's id (for dependencies) and the
    // placeholder of whoever advances from it (for the next round's rest gap).
    const itemIdAt = new Map<string, string>();
    const advanceAt = new Map<string, string>();

    for (let round = 1; round <= rounds; round += 1) {
      const existingThisRound = rows.filter(
        (row) => row.round === round && !row.is_bye && row.status !== "void",
      ).length;
      uncreatedMatches += roundWorkload({
        bracketSize: draw.bracket_size,
        entrantCount: draw.entrant_count,
        round,
        existingMatchesInRound: existingThisRound,
      }).synthetic;

      const slots = slotsInRound(draw.bracket_size, round);
      for (let slot = 1; slot <= slots; slot += 1) {
        const key = `${round}|${slot}`;
        const row = rowAt.get(key);
        if (row?.is_bye) {
          advanceAt.set(key, byeToken(row.id));
          continue;
        }

        const feederKeys =
          round === 1 ? [] : [`${round - 1}|${slot * 2 - 1}`, `${round - 1}|${slot * 2}`];
        const feederItemIds = feederKeys
          .map((feederKey) => itemIdAt.get(feederKey))
          .filter((id): id is string => id != null);
        const feederDeps = movableFeeders(feederItemIds, input.pinById, productionById);
        const eligibleFrom = eligibleFromFeeders(
          feederItemIds,
          input.pinById,
          productionById,
          input.restGap,
        );
        const feederTokens = feederKeys
          .map((feederKey) => advanceAt.get(feederKey))
          .filter((token): token is string => token != null);

        if (row != null) {
          const existing = productionById.get(row.id);
          if (existing != null) {
            // A decided row: keep the planner's item, add this match's winner placeholder and the
            // feeder dependencies the production plan deliberately does not carry.
            const item: StageItem = {
              ...existing,
              participantIds: [...existing.participantIds, winnerToken(row.id)],
              ...(feederDeps.length ? { dependencies: feederDeps } : {}),
            };
            items.push(item);
            itemIdAt.set(key, item.id);
          } else {
            // A row whose two sides are not decided yet: it is not a match the solver can place on
            // its own, so it gets placeholders and, with them, the round's real rest ordering.
            const id = `${SYNTHETIC_PREFIX}row:${row.id}`;
            items.push(
              syntheticItem({
                id,
                categoryId,
                entrantTokens: feederTokens,
                dependencies: feederDeps,
                ...(eligibleFrom == null ? {} : { eligibleFrom }),
                round,
                slot,
                slotMinutes: input.slotMinutes,
                restGap: input.restGap,
                softOrder,
              }),
            );
            itemIdAt.set(key, id);
          }
        } else {
          // No row at all: an inevitable match the tournament has not created yet.
          const id = `${SYNTHETIC_PREFIX}${draw.id}:r${round}:m${slot}`;
          items.push(
            syntheticItem({
              id,
              categoryId,
              entrantTokens: feederTokens,
              dependencies: feederDeps,
              ...(eligibleFrom == null ? {} : { eligibleFrom }),
              round,
              slot,
              slotMinutes: input.slotMinutes,
              restGap: input.restGap,
              softOrder,
            }),
          );
          itemIdAt.set(key, id);
        }
        advanceAt.set(key, winnerToken(itemIdAt.get(key)!));
      }
    }
  }

  return { items, uncreatedMatches };
}

/**
 * Placement round two, which no row describes until every round-one result is in.
 *
 * The format invariant is that every active entrant plays exactly two placement matches, so
 * `expectedR2 = N <= 2 ? 0 : ceil(N / 2)` and `missing = max(0, expectedR2 - existing R2 rows)`.
 * Which round-one match feeds which round-two slot is outcome-dependent (make-ups, crossover), so
 * it is deliberately not reconstructed: a synthetic round-two item waits on every round-one match
 * in its category, which is the real gate the generator uses, and nothing more specific.
 *
 * A round-one match that is already placed (or pinned) cannot be named as a dependency on an
 * earlier day, so it is not listed among them. The rest bound below still covers it: every
 * synthetic round-two item also carries `eligibleFrom = latestRound1Finish + placementRest` for
 * its category, read from the estimator's own real-only sweep, so the gate and the bound together
 * give `start(R2) >= max(latest R1 end) + rest` whichever way the feeder was pinned.
 */
export function buildPlacementRoundTwoForecastItems(input: {
  entrants: readonly PlacementEntrant[];
  placementMatches: readonly PlacementMatch[];
  /** Real placement item ids in the forecast batch, so a dependency is always resolvable. */
  placementItemIds: ReadonlySet<string>;
  /** The batch's placement items, so a pinned feeder's end can be read. */
  placementItems: readonly StageItem[];
  /** Slots the plan is already holding, so a pinned feeder is a floor rather than a dependency. */
  pinById: ReadonlyMap<string, Pin>;
  /** Latest round-one finish per category, from the estimator's real-only sweep. */
  r1LatestEndByCategory: ReadonlyMap<string, number>;
  categoryOrder: ReadonlyMap<string, number>;
  slotMinutes: number;
  restGap: number;
}): ForecastItemsResult {
  const placementById = new Map(input.placementItems.map((item) => [item.id, item]));
  const activeByCategory = new Map<string, number>();
  for (const entrant of input.entrants) {
    if (entrant.excluded) continue;
    activeByCategory.set(entrant.category_id, (activeByCategory.get(entrant.category_id) ?? 0) + 1);
  }

  const roundOneByCategory = new Map<string, string[]>();
  const roundTwoByCategory = new Map<string, number>();
  for (const match of input.placementMatches) {
    if (match.status === "void") continue;
    if (match.stage === "round1") {
      if (!input.placementItemIds.has(match.id)) continue;
      const list = roundOneByCategory.get(match.category_id) ?? [];
      list.push(match.id);
      roundOneByCategory.set(match.category_id, list);
    } else if (match.stage === "round2") {
      roundTwoByCategory.set(
        match.category_id,
        (roundTwoByCategory.get(match.category_id) ?? 0) + 1,
      );
    }
  }

  const items: StageItem[] = [];
  let uncreatedMatches = 0;
  for (const [categoryId, active] of [...activeByCategory.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (active <= 2) continue;
    const missing = placementRoundTwoWorkload({
      activeEntrants: active,
      existingRoundTwoMatches: roundTwoByCategory.get(categoryId) ?? 0,
    });
    if (missing === 0) continue;
    const roundOneIds = (roundOneByCategory.get(categoryId) ?? []).slice().sort();
    const dependencies = movableFeeders(roundOneIds, input.pinById, placementById);
    const latestRoundOneEnd = input.r1LatestEndByCategory.get(categoryId);
    const eligibleFrom =
      latestRoundOneEnd == null ? undefined : latestRoundOneEnd + input.restGap * MINUTE;
    for (let index = 1; index <= missing; index += 1) {
      uncreatedMatches += 1;
      items.push(
        syntheticItem({
          id: `${SYNTHETIC_PREFIX}placement:${categoryId}:r2:m${index}`,
          categoryId,
          entrantTokens: [],
          dependencies,
          ...(eligibleFrom == null ? {} : { eligibleFrom }),
          round: 2,
          slot: index,
          slotMinutes: input.slotMinutes,
          restGap: input.restGap,
          softOrder: input.categoryOrder.get(categoryId) ?? 0,
        }),
      );
    }
  }

  return { items, uncreatedMatches };
}

// ---------------------------------------------------------------------------------------------
// The estimator
// ---------------------------------------------------------------------------------------------

export interface EstimateFinishInput {
  tournament: Tournament;
  days: readonly TournamentDay[];
  allCourts: readonly Court[];
  dayCourtIds?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  breaksByDayId?: ReadonlyMap<string, readonly TournamentDayBreak[]> | undefined;
  teams: readonly Team[];
  entrants: readonly PlacementEntrant[];
  draws: readonly TierDraw[];
  placementMatches: readonly PlacementMatch[];
  tierMatches: readonly TierDrawMatch[];
  categoryOrder: ReadonlyMap<string, number>;
  options?: DayOneSchedulerOptions | undefined;
  now?: number | undefined;
  /**
   * The planner's real items, when the caller already built them. Passing them keeps the estimator
   * from rebuilding row-to-item conversion and guarantees it forecasts the exact same universe.
   */
  placementAll?: readonly StageItem[] | undefined;
  knockoutAll?: readonly StageItem[] | undefined;
  /**
   * The plan's real slots. When present, the rebuilt plan is pinned and only the remainder is
   * forecast; when absent, rows with a `scheduled_time` are pinned and the current live state is
   * forecast. Both are forecasts of the same work, which is what makes the two comparable.
   */
  placedSlots?: readonly ScheduledSlot[] | undefined;
}

export interface TournamentForecast {
  estimate: FinishEstimate;
  /** Every slot the forecast produced, pinned plan slots included. */
  slots: readonly ScheduledSlot[];
  /** Ids that could not be placed even with the last day unbounded. */
  unscheduled: readonly string[];
  /** Ids that were movable forecast work (not pinned anchors). */
  movableIds: readonly string[];
}

interface Pin {
  start: number;
  end: number;
  courtNumber?: number | undefined;
}

function pinItem(item: StageItem, pin: Pin | undefined): StageItem {
  if (!pin) return item;
  return {
    ...item,
    fixed: true,
    start: pin.start,
    end: pin.end,
    ...(pin.courtNumber == null ? {} : { courtNumber: pin.courtNumber }),
  };
}

/**
 * Forecasts the whole tournament from a given known state.
 *
 * Read-only: the returned slots are a fresh array and no input object is modified.
 */
export function forecastTournament(input: EstimateFinishInput): TournamentForecast {
  const now = input.now ?? Date.now();
  const nextWholeMinute = Math.ceil(now / MINUTE) * MINUTE;
  const orderedDays = [...input.days].sort((a, b) => a.day_number - b.day_number);
  const placementSlot = input.tournament.group_slot_minutes;
  const placementRest = input.tournament.group_rest_gap_minutes;
  const knockoutSlot = input.tournament.knockout_slot_minutes;
  const knockoutRest = input.tournament.knockout_rest_gap_minutes;

  const playerLookup = buildPlayerLookup(input.entrants, input.teams);
  const courtNumberById = new Map(input.allCourts.map((court) => [court.id, court.number]));
  const drawCategory = new Map(input.draws.map((draw) => [draw.id, draw.category_id]));

  const existing = [...input.placementMatches, ...input.tierMatches];
  const isRebuild = existing.some(
    (match) => match.status !== "void" && match.scheduled_time != null,
  );
  const firstDayStart = orderedDays.length
    ? new Date(`${orderedDays[0]!.date}T${orderedDays[0]!.start_time}`).getTime()
    : nextWholeMinute;
  const itemFloor = isRebuild ? Math.max(firstDayStart, nextWholeMinute) : firstDayStart;

  const placementAll =
    input.placementAll ??
    placementItems({
      matches: input.placementMatches,
      playerLookup,
      courtNumberById,
      categoryOrder: input.categoryOrder,
      slotMinutes: placementSlot,
      restGap: placementRest,
      floor: itemFloor,
      now,
    });
  const knockoutAll =
    input.knockoutAll ??
    tierItems({
      matches: input.tierMatches,
      drawCategory,
      playerLookup,
      courtNumberById,
      categoryOrder: input.categoryOrder,
      slotMinutes: knockoutSlot,
      restGap: knockoutRest,
      floor: itemFloor,
      now,
    });

  /** Every fixed occupancy, by court, so a movable row can be tested against the ones it loses to. */
  const fixedOccupancies = [...placementAll, ...knockoutAll]
    .filter((item) => item.fixed && item.start != null && item.end != null)
    .map((item) => ({ courtNumber: item.courtNumber, start: item.start!, end: item.end! }));

  /**
   * What the plan is already holding. Built before the forecast items because a feeder that is
   * pinned cannot be named as a dependency; the builder folds its end into `eligibleFrom` instead.
   */
  const pinById = new Map<string, Pin>();
  if (input.placedSlots) {
    for (const slot of input.placedSlots) {
      pinById.set(slot.matchId, {
        start: slot.start.getTime(),
        end: slot.end.getTime(),
        courtNumber: slot.courtNumber,
      });
    }
  } else {
    for (const row of existing) {
      if (row.status === "void" || row.scheduled_time == null) continue;
      if ("is_bye" in row && row.is_bye) continue;
      if (isFixed(row.status)) continue; // already pinned with its real window
      const start = new Date(row.scheduled_time).getTime();
      const slotMinutes = "is_bye" in row ? knockoutSlot : placementSlot;
      const courtNumber = row.court_id ? courtNumberById.get(row.court_id) : undefined;
      const end = start + slotMinutes * MINUTE;
      /**
       * A movable row's `scheduled_time` is where the desk has it *now*, and pinning it is what
       * makes the live-state forecast describe the live state.
       *
       * A row the day has already overtaken is the exception. An in-progress match holds its court
       * until at least one slot past `now`, so a row the clock has passed on that same court is
       * not placed in any meaningful sense — the desk has to move it. Pinning both would describe
       * an impossible court rather than a late one, and the core refuses the whole batch, which
       * would leave the live forecast permanently unavailable in exactly the situation it is read
       * for. Production reschedules those rows; the live forecast leaves them movable too.
       */
      if (
        courtNumber != null &&
        fixedOccupancies.some(
          (held) => held.courtNumber === courtNumber && held.start < end && held.end > start,
        )
      ) {
        continue;
      }
      pinById.set(row.id, {
        start,
        end,
        ...(courtNumber == null ? {} : { courtNumber }),
      });
    }
  }

  const tierForecast = buildTierForecastItems({
    draws: input.draws,
    tierMatches: input.tierMatches,
    productionItems: knockoutAll,
    pinById,
    drawCategory,
    categoryOrder: input.categoryOrder,
    slotMinutes: knockoutSlot,
    restGap: knockoutRest,
  });
  const placementItemIds = new Set(placementAll.map((item) => item.id));
  const placementRealRunItems = placementAll.map((item) => pinItem(item, pinById.get(item.id)));
  const knockoutRealRunItems = knockoutAll.map((item) => pinItem(item, pinById.get(item.id)));

  const runDays = (placementItems: readonly StageItem[], knockoutItems: readonly StageItem[]) =>
    runPlanDays({
      orderedDays,
      allCourts: input.allCourts,
      ...(input.dayCourtIds ? { dayCourtIds: input.dayCourtIds } : {}),
      ...(input.breaksByDayId ? { breaksByDayId: input.breaksByDayId } : {}),
      placementAll: placementItems,
      knockoutAll: knockoutItems,
      placementSlotMinutes: placementSlot,
      placementRestGapMinutes: placementRest,
      knockoutSlotMinutes: knockoutSlot,
      knockoutRestGapMinutes: knockoutRest,
      isRebuild,
      nextWholeMinute,
      // A forecast replays a partly placed event, so a pinned knockout on a court must
      // block the placement work that has no row yet. Production schedules forward and
      // never needs this.
      sharedAnchors: true,
      ...(input.options ? { options: input.options } : {}),
    });

  /**
   * A forecast is best-effort: the rows as they stand may already be an impossible layout, which
   * the core is right to refuse, but refusing a *forecast* must not refuse a build. The caller
   * gets an `invalid` estimate instead, and the desk keeps working.
   */
  const runDaysSafely = (
    placementStageItems: readonly StageItem[],
    knockoutStageItems: readonly StageItem[],
  ): PlanDaysResult | null => {
    try {
      return runDays(placementStageItems, knockoutStageItems);
    } catch (error) {
      if (error instanceof ProblemValidationError) return null;
      throw error;
    }
  };

  // Sweep one: real work only. It gives round one's finish per category without any synthetic
  // round-two match competing for a court, which is the bound the rest gap needs. Round two
  // depends on round one, so it never delayed it anyway: the sweep is the same placement round one
  // the full run makes, and adding round two afterwards cannot move it.
  const realRun = runDaysSafely(placementRealRunItems, knockoutRealRunItems);
  const roundOneIds = new Set(
    input.placementMatches
      .filter((match) => match.stage === "round1" && match.status !== "void")
      .map((match) => match.id),
  );
  const r1LatestEndByCategory = new Map<string, number>();
  for (const slot of realRun?.allSlots ?? []) {
    if (!roundOneIds.has(slot.matchId)) continue;
    r1LatestEndByCategory.set(
      slot.categoryId,
      Math.max(r1LatestEndByCategory.get(slot.categoryId) ?? 0, slot.end.getTime()),
    );
  }

  const placementForecast = buildPlacementRoundTwoForecastItems({
    entrants: input.entrants,
    placementMatches: input.placementMatches,
    placementItemIds,
    placementItems: placementAll,
    pinById,
    r1LatestEndByCategory,
    categoryOrder: input.categoryOrder,
    slotMinutes: placementSlot,
    restGap: placementRest,
  });

  const placementRunItems: StageItem[] = [...placementRealRunItems, ...placementForecast.items];
  const knockoutRunItems: StageItem[] = tierForecast.items.map((item) =>
    pinItem(item, pinById.get(item.id)),
  );

  const movableIds = [...placementRunItems, ...knockoutRunItems]
    .filter((item) => !item.fixed)
    .map((item) => item.id)
    .sort();

  /**
   * The floor: the latest end among work that is already placed.
   *
   * Two sources, because a played row is not necessarily in `pinById`. A row with a
   * `scheduled_time` is pinned there; a reported row with only an `ended_at` is fixed straight
   * from its real window by the row-to-item builders, and `pinById` deliberately skips it. Reading
   * only `pinById` would report no floor at all for a tournament whose matches were played but
   * never laid out, and the forecast could then name a finish before the last real end.
   */
  let placedFinishMs: number | null = null;
  for (const pin of pinById.values()) {
    placedFinishMs = placedFinishMs == null ? pin.end : Math.max(placedFinishMs, pin.end);
  }
  for (const item of [...placementRunItems, ...knockoutRunItems]) {
    if (!item.fixed || item.end == null) continue;
    placedFinishMs = placedFinishMs == null ? item.end : Math.max(placedFinishMs, item.end);
  }

  const uncreatedMatches = tierForecast.uncreatedMatches + placementForecast.uncreatedMatches;

  // Sweep two: the real plan plus the synthetic remainder. This is the forecast.
  const result = runDaysSafely(placementRunItems, knockoutRunItems);
  if (result == null) {
    // The rows are already an impossible layout, so there is no simulation to read and no honest
    // clock time. Reported, never thrown: the desk's build must still succeed.
    return invalidForecast({
      placedFinishMs,
      remainingMatches: movableIds.length,
      uncreatedMatches,
      unplacedMatches: 0,
    });
  }

  // Only real rows count as unplaced; a synthetic item that would not fit means the last day could
  // not contain the event at all, which is reported through the same overflow branch.
  const unscheduledReal = [...result.placementUnscheduled, ...result.knockoutUnscheduled].filter(
    (id) => !isSyntheticId(id),
  );

  const lastFinishMs = result.lastFinishMs;
  const finishMs =
    lastFinishMs == null
      ? placedFinishMs
      : placedFinishMs == null
        ? lastFinishMs
        : Math.max(lastFinishMs, placedFinishMs);

  const finishIso = finishMs == null ? null : new Date(finishMs).toISOString();
  const placedIso = placedFinishMs == null ? null : new Date(placedFinishMs).toISOString();
  const lastCloseMs = result.lastCourtDayPlanningEndMs;

  // ---- classification ----
  let basis: FinishBasis;
  let deficitMinutes: number | null = null;
  let finish: string | null = finishIso;
  let unplacedMatches = unscheduledReal.length;

  if (
    unscheduledReal.length > 0 ||
    (result.daysWithCourts === 0 && movableIds.length > 0) ||
    (result.days.length === 0 && movableIds.length > 0)
  ) {
    // Something cannot be placed even with the last day unbounded, so no honest clock time exists.
    basis = "overflow";
    finish = null;
    unplacedMatches = Math.max(unplacedMatches, movableIds.length);
  } else if (finishMs != null && lastCloseMs > 0 && finishMs > lastCloseMs) {
    // It fits, but only by running past the final close: name the extension, not the close.
    basis = "overflow";
    deficitMinutes = Math.round((finishMs - lastCloseMs) / MINUTE);
  } else if (movableIds.length === 0) {
    basis = "placed";
  } else {
    basis = "projected";
  }

  const estimate: FinishEstimate = {
    finish,
    placedFinish: placedIso,
    unplacedMatches,
    uncreatedMatches,
    deficitMinutes,
    basis,
    remainingMatches: movableIds.length,
    days: result.daysWithCourts,
  };

  return {
    estimate,
    slots: result.allSlots,
    unscheduled: [...result.placementUnscheduled, ...result.knockoutUnscheduled],
    movableIds,
  };
}

/** Convenience wrapper when only the estimate is wanted. */
export function estimateFinish(input: EstimateFinishInput): FinishEstimate {
  return forecastTournament(input).estimate;
}

/**
 * The "no honest number" forecast, for rows that are already an impossible layout.
 *
 * Deliberately not a `throw`: the forecast is a nicety, and the schedule page, the rebuild preview
 * and the desk KPI all call it on the critical path of a build. What it knows without simulating —
 * the floor and the outstanding work — is still reported, so the UI can say "estimate unavailable,
 * N matches still to play" instead of inventing a time or taking the page down.
 */
function invalidForecast(input: {
  placedFinishMs: number | null;
  remainingMatches: number;
  uncreatedMatches: number;
  unplacedMatches: number;
}): TournamentForecast {
  return {
    estimate: {
      finish: null,
      placedFinish:
        input.placedFinishMs == null ? null : new Date(input.placedFinishMs).toISOString(),
      unplacedMatches: input.unplacedMatches,
      uncreatedMatches: input.uncreatedMatches,
      deficitMinutes: null,
      basis: "invalid",
      remainingMatches: input.remainingMatches,
      days: 0,
    },
    slots: [],
    unscheduled: [],
    movableIds: [],
  };
}
