/**
 * Tournament progress by event, stage and round.
 *
 * The organizer's question is "how far through is each part of the event, and is the next part
 * ready to be generated?". This module answers it once, in a shape the UI can render without
 * knowing anything about the format it came from.
 *
 * The model is deliberately format-agnostic: a row carries adapter-supplied labels
 * (`eventLabel`, `stageLabel`, `roundLabel`) and counts. That is what keeps the shared
 * component free of stage and tier literals — a new format means a new adapter, not an edit to
 * the component. Readiness wording is adapter-supplied for the same reason.
 *
 * Progress is measured against **the rows that exist**. It reports how many of them have been
 * created and how many are done, and never an expected total for work that has not been
 * generated: a stage's size is a forecasting question, and this module deliberately does not
 * forecast. Where a round's depth matters — telling a final from an intermediate round it can
 * offer a successor to — it comes from `bracketRoundCount`, the bracket builder's own answer,
 * rather than a re-derivation.
 *
 * One count is still borrowed from a format generator: a pool's outstanding matches come from
 * `buildRoundRobin`, the same routine that would create them, so "N matches still to come" is
 * the generator's number rather than a guess.
 *
 * Readiness is likewise borrowed, never re-decided: the placement gate, `tierRoundComplete` and
 * `poolIsComplete` are the same checks their own tabs gate their generate buttons on.
 *
 * Pure and read-only. It reads rows and returns counts; it never writes and never runs the
 * scheduler.
 */

import { buildRoundRobin } from "./scheduling/formats/round-robin";
import type {
  Category,
  Draw,
  DrawMatch,
  PlacementEntrant,
  PlacementMatch,
  Pool,
  PoolEntry,
  PoolMatch,
  TierDraw,
  TierDrawMatch,
} from "./data";
import { buildCategoryView } from "./placement-actions";
import { poolIsComplete } from "./standings";
import { bracketRoundCount, tierRoundComplete } from "./tier-draw";

/** Statuses that mean a match has been decided and needs nothing more from anyone. */
const PLAYED = new Set(["reported", "walkover"]);

export interface StageProgressRow {
  /** Stable key, unique across the whole list. */
  key: string;
  /** The event this belongs to, e.g. a category code, or null when unknown. */
  eventLabel: string | null;
  /** The stage, e.g. "Placement" or "Tier A". Adapter-supplied. */
  stageLabel: string;
  /** The round, e.g. "Round 1". Adapter-supplied; null for a stage-level row. */
  roundLabel: string | null;
  /** Rows that already exist and are playable. */
  created: number;
  /** Rows that have been reported or walked over. */
  completed: number;
  /** True when this row's next step can be generated right now. */
  canAdvance: boolean;
  /** What that next step is, when it can be generated. Adapter-supplied. */
  advanceLabel: string | null;
  /** Why it cannot be advanced yet, when that is worth saying. Adapter-supplied. */
  blockedReason: string | null;
}

export interface StageProgressInput {
  categories?: readonly Category[] | null | undefined;
  /** Event ordering, so the list matches the rest of the app. */
  categoryOrder?: ReadonlyMap<string, number> | undefined;
  entrants?: readonly PlacementEntrant[] | null | undefined;
  placementMatches?: readonly PlacementMatch[] | null | undefined;
  tierDraws?: readonly TierDraw[] | null | undefined;
  tierMatches?: readonly TierDrawMatch[] | null | undefined;
  pools?: readonly Pool[] | null | undefined;
  poolEntries?: readonly PoolEntry[] | null | undefined;
  poolMatches?: readonly PoolMatch[] | null | undefined;
  draws?: readonly Draw[] | null | undefined;
  drawMatches?: readonly DrawMatch[] | null | undefined;
}

function groupBy<T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

function completion(rows: readonly { status: string }[]): number {
  return rows.filter((row) => PLAYED.has(row.status)).length;
}

/** "1 match" / "3 matches". */
function matchCount(count: number): string {
  return `${count} match${count === 1 ? "" : "es"}`;
}

/** "1 entrant" / "3 entrants". */
function entrantCount(count: number): string {
  return `${count} entrant${count === 1 ? "" : "s"}`;
}

function readyOrBlocked(
  ready: { advanceLabel: string } | null,
  blockedReason: string | null,
): Pick<StageProgressRow, "canAdvance" | "advanceLabel" | "blockedReason"> {
  if (ready) return { canAdvance: true, advanceLabel: ready.advanceLabel, blockedReason: null };
  return { canAdvance: false, advanceLabel: null, blockedReason };
}

/**
 * The placement stage: round one and round two, per event.
 *
 * Reuses `buildCategoryView`, which is the same view model the Placement tab gates its generate
 * buttons on. That is deliberate: "round one is settled, so round two can be generated" and
 * "every entrant has played both matches, so the draws can be generated" are the gate's answers,
 * and a second opinion here would be a second set of rules.
 *
 * A round row is emitted while the field is big enough to have that round — the view's own
 * `roundOneExpected`/`roundTwoExpected`, which are booleans, not counts. That keeps a home for
 * "Ready to generate round two" before that round exists.
 *
 * Draw readiness is reported on the last row of the stage, because after it there is no
 * placement round left — that is what absorbs the Desk's removed "Draws ready" link.
 */
function placementRows(input: StageProgressInput, codeOf: (id: string) => string | null) {
  const rows: StageProgressRow[] = [];
  const entrantsByCategory = groupBy(input.entrants ?? [], (row) => row.category_id);
  const matchesByCategory = groupBy(input.placementMatches ?? [], (row) => row.category_id);

  for (const [categoryId, categoryEntrants] of entrantsByCategory) {
    const matches = matchesByCategory.get(categoryId) ?? [];
    const view = buildCategoryView(categoryEntrants, matches);
    const eventLabel = codeOf(categoryId);

    const roundOne = view.roundOne.filter((match) => match.status !== "void");
    const roundTwo = view.roundTwo.filter((match) => match.status !== "void");

    const roundOneUndecided = roundOne.filter((match) => !PLAYED.has(match.status)).length;
    const roundOnePending =
      roundOne.length === 0
        ? "Round one is not generated yet"
        : roundOneUndecided > 0
          ? `${matchCount(roundOneUndecided)} still to decide in round one`
          : null;
    const drawsReady = view.gate.ready;
    const short = view.gate.short.length;

    if (view.roundOneExpected) {
      const ungenerated = roundOne.length === 0;
      const onlyStage = !view.roundTwoExpected;
      rows.push({
        key: `placement:${categoryId}:r1`,
        eventLabel,
        stageLabel: "Placement",
        roundLabel: "Round 1",
        created: roundOne.length,
        completed: completion(roundOne),
        ...(ungenerated
          ? readyOrBlocked(
              view.seedsLocked ? { advanceLabel: "Ready to generate round one" } : null,
              view.seedsLocked ? null : "Seeds are not locked yet",
            )
          : onlyStage && drawsReady
            ? readyOrBlocked({ advanceLabel: "Draws ready" }, null)
            : readyOrBlocked(null, onlyStage ? roundOnePending : null)),
      });
    }

    if (view.roundTwoExpected) {
      const ungenerated = roundTwo.length === 0;
      rows.push({
        key: `placement:${categoryId}:r2`,
        eventLabel,
        stageLabel: "Placement",
        roundLabel: "Round 2",
        created: roundTwo.length,
        completed: completion(roundTwo),
        ...(ungenerated
          ? readyOrBlocked(
              roundOnePending === null ? { advanceLabel: "Ready to generate round two" } : null,
              roundOnePending,
            )
          : drawsReady
            ? readyOrBlocked({ advanceLabel: "Draws ready" }, null)
            : readyOrBlocked(
                null,
                short > 0 ? `${entrantCount(short)} still need placement results` : null,
              )),
      });
    }
  }

  return rows;
}

/**
 * The A/B/C/D knockouts: one row per round the draw actually has, deepest last.
 *
 * A bye is not a match, so it is excluded from both counts — the same filter the planner uses.
 * A round with no row at all contributes no row: progress is reported against what exists, so
 * there is nothing to say about a round nobody has generated yet. The deepest round is the one
 * that can still unlock its successor, and `bracketRoundCount` is what tells a final round from
 * an intermediate one.
 */
function knockoutRows(input: StageProgressInput, codeOf: (id: string) => string | null) {
  const rows: StageProgressRow[] = [];
  const matchesByDraw = groupBy(input.tierMatches ?? [], (row) => row.draw_id);

  for (const draw of input.tierDraws ?? []) {
    if (draw.bracket_size <= 1 || draw.entrant_count <= 1) continue;
    const rounds = bracketRoundCount(draw.bracket_size);
    if (rounds <= 0) continue;

    const drawMatches = matchesByDraw.get(draw.id) ?? [];
    const eventLabel = codeOf(draw.category_id);
    const stageLabel = draw.tier ? `Tier ${draw.tier}` : "Knockout";

    const playableInRound = (round: number) =>
      drawMatches.filter(
        (match) => match.round === round && !match.is_bye && match.status !== "void",
      );

    const roundsWithRows = [
      ...new Set(
        drawMatches
          .filter((match) => !match.is_bye && match.status !== "void")
          .map((match) => match.round),
      ),
    ].sort((a, b) => a - b);
    const deepestCreated = roundsWithRows.length ? roundsWithRows[roundsWithRows.length - 1]! : 0;

    const deepestPlayable = deepestCreated === 0 ? [] : playableInRound(deepestCreated);
    const deepestDecided =
      deepestCreated > 0 &&
      tierRoundComplete(
        deepestPlayable.map((match) => ({ slot: match.slot, winnerId: match.winner_id })),
      );
    const deepestUndecided = deepestPlayable.filter((match) => !PLAYED.has(match.status)).length;

    for (const round of roundsWithRows) {
      const playable = playableInRound(round);
      const isDeepest = round === deepestCreated;
      const moreRounds = round < rounds;

      const readiness = !isDeepest
        ? readyOrBlocked(null, null)
        : !moreRounds
          ? // The final round has nothing after it but its own result.
            readyOrBlocked(
              null,
              deepestUndecided > 0 ? `${matchCount(deepestUndecided)} still to decide` : null,
            )
          : deepestDecided && draw.champion_id == null
            ? readyOrBlocked({ advanceLabel: `Ready for round ${round + 1}` }, null)
            : readyOrBlocked(
                null,
                deepestUndecided > 0
                  ? `${matchCount(deepestUndecided)} still to decide in round ${deepestCreated}`
                  : "Waiting on the previous round",
              );

      rows.push({
        key: `tier:${draw.id}:r${round}`,
        eventLabel,
        stageLabel,
        roundLabel: `Round ${round}`,
        created: playable.length,
        completed: completion(playable),
        ...readiness,
      });
    }
  }

  return rows;
}

/**
 * The legacy round-robin format: one row per pool, one per knockout draw round.
 *
 * Group readiness reuses `poolIsComplete`, the same check the Draws tab gates on. How many
 * matches a pool still owes comes from `buildRoundRobin` — the generator that would create
 * them — because that is a known fixture list rather than a forecast.
 */
function roundRobinRows(input: StageProgressInput, codeOf: (id: string) => string | null) {
  const rows: StageProgressRow[] = [];
  const entriesByPool = groupBy(input.poolEntries ?? [], (row) => row.pool_id);
  const matchesByPool = groupBy(input.poolMatches ?? [], (row) => row.pool_id);

  for (const pool of input.pools ?? []) {
    const teamIds = (entriesByPool.get(pool.id) ?? []).map((entry) => entry.team_id);
    if (teamIds.length < 2) continue;
    const poolMatches = matchesByPool.get(pool.id) ?? [];
    const playable = poolMatches.filter((match) => match.status !== "void");
    const expected = buildRoundRobin({ entrants: teamIds, groupKey: pool.id }).length;

    rows.push({
      key: `pool:${pool.id}`,
      eventLabel: codeOf(pool.category_id),
      stageLabel: "Group",
      roundLabel: pool.name,
      created: playable.length,
      completed: completion(playable),
      ...(poolIsComplete(teamIds, poolMatches)
        ? readyOrBlocked({ advanceLabel: "Ready for the draw" }, null)
        : readyOrBlocked(
            null,
            Math.max(0, expected - completion(playable)) > 0
              ? `${matchCount(expected - completion(playable))} still to come`
              : null,
          )),
    });
  }

  const drawMatchesByDraw = groupBy(input.drawMatches ?? [], (row) => row.draw_id);
  for (const draw of input.draws ?? []) {
    if (draw.bracket_size <= 1 || draw.entrant_count <= 1) continue;
    const rounds = bracketRoundCount(draw.bracket_size);
    const drawMatches = drawMatchesByDraw.get(draw.id) ?? [];
    const roundsWithRows = [
      ...new Set(drawMatches.filter((m) => !m.is_bye && m.status !== "void").map((m) => m.round)),
    ].sort((a, b) => a - b);

    for (const round of roundsWithRows) {
      if (round < 1 || round > rounds) continue;
      const playable = drawMatches.filter(
        (match) => match.round === round && !match.is_bye && match.status !== "void",
      );
      rows.push({
        key: `draw:${draw.id}:r${round}`,
        eventLabel: codeOf(draw.category_id),
        stageLabel: draw.tier ? `Draw ${draw.tier}` : "Draw",
        roundLabel: `Round ${round}`,
        created: playable.length,
        completed: completion(playable),
        canAdvance: false,
        advanceLabel: null,
        blockedReason: null,
      });
    }
  }

  return rows;
}

/**
 * Every stage row for the tournament, in event order and then by stage.
 *
 * Formats that contribute nothing simply contribute no rows, so one function serves a placement
 * tournament, a round-robin one and anything that mixes them.
 */
export function buildStageProgress(input: StageProgressInput): StageProgressRow[] {
  const categories = input.categories ?? [];
  const codeById = new Map(categories.map((category) => [category.id, category.code]));
  const codeOf = (id: string) => codeById.get(id) ?? null;

  // Event order, keyed by the label the adapters emit, so a row can be sorted without carrying
  // the category id through the public shape.
  const orderByCode = new Map<string, number>();
  for (const category of categories) {
    orderByCode.set(category.code, input.categoryOrder?.get(category.id) ?? 0);
  }

  const rows = [
    ...placementRows(input, codeOf),
    ...knockoutRows(input, codeOf),
    ...roundRobinRows(input, codeOf),
  ];

  return rows.sort(
    (a, b) =>
      (orderByCode.get(a.eventLabel ?? "") ?? 0) - (orderByCode.get(b.eventLabel ?? "") ?? 0) ||
      (a.eventLabel ?? "").localeCompare(b.eventLabel ?? "") ||
      a.stageLabel.localeCompare(b.stageLabel) ||
      (a.roundLabel ?? "").localeCompare(b.roundLabel ?? ""),
  );
}
