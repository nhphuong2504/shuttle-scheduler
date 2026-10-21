/**
 * Tournament progress by event and stage.
 *
 * The organizer's question is "how far through is each part of the event, and is the next part
 * ready to be generated?". This module answers it once, in a shape the UI can render without
 * knowing anything about the format it came from.
 *
 * The pipeline is explicit. A two-round placement event runs
 *
 *     Round 1 → Round 2 → Knockout → Tournament Complete
 *
 * and every stage answers with the same three things: a status, a match count and at most one
 * action. A status is `completed`, `current` or `waiting`, which the view draws as `✓`, `●` and
 * `○`. A stage is complete when the domain says so, current once it has rows to play, and
 * waiting until then — one rule, so a stage can never read "in progress" and "not generated" at
 * the same time.
 *
 * Progress is always counted in MATCHES — "12 / 19 matches completed", "7 matches remaining" —
 * and never in entrants. The placement gate still counts entrants internally, because that is
 * what decides whether a round may be generated, but an entrant count is not a progress measure:
 * five undecided round-two matches involving six entrants are five matches to play, not six of
 * anything. The gate's shortfall is deliberately not this module's headline, and a stage that
 * cannot advance says *which stage it is waiting on* instead.
 *
 * Counts are measured against **the rows that exist**. Placement rounds report the matches that
 * have been generated, so a round nobody has created is waiting rather than a forecast. The
 * knockout is the one stage whose size is known before its rows are: a single-elimination bracket
 * over N entrants plays exactly N - 1 matches once its byes are excluded, because every match
 * eliminates one entrant. That is a property of the draw rather than a forecast, and it is what
 * lets a half-generated bracket read "2 / 3 matches completed" instead of "2 / 2" — a count that
 * would claim the final was decided while it did not yet exist.
 *
 * Readiness is borrowed, never re-decided: the placement gate, `poolIsComplete` and
 * `buildRoundRobin` are the same checks and the same generator their own tabs use. A second
 * opinion here would be a second set of rules.
 *
 * The model is format-agnostic: a row carries adapter-supplied labels (`eventLabel`,
 * `stageLabel`, `roundLabel`) and action wording. That is what keeps the shared component free of
 * stage and tier literals — a new format means a new adapter, not an edit to the component.
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
import { bracketRoundCount } from "./tier-draw";

/** Statuses that mean a match has been decided and needs nothing more from anyone. */
const PLAYED = new Set(["reported", "walkover"]);

/** Statuses that mean nothing more will ever be entered: a void is over, not outstanding. */
const SETTLED = new Set(["reported", "walkover", "void"]);

/** How a stage is doing. The view owns the glyph; this owns the meaning. */
export type StageStatus = "completed" | "current" | "waiting";

/** The one thing that moves a stage along, when there is one. */
export interface StageAction {
  /** `generate` creates the stage; `enter-results` opens the surface that scores it. */
  kind: "generate" | "enter-results";
  /** Adapter-supplied. Always the verb first, e.g. "Generate Round 2". */
  label: string;
  /**
   * The event the action belongs to, for whoever owns it — the placement pipeline generates a
   * stage one category at a time. Opaque here: this module never interprets it and the view
   * only hands it back.
   */
  scopeId: string | null;
}

export interface StageProgressRow {
  /** Stable key, unique across the whole list. */
  key: string;
  /** The event this belongs to, e.g. a category code, or null when unknown. */
  eventLabel: string | null;
  /** The stage, e.g. "Round 1" or "Knockout". Adapter-supplied. */
  stageLabel: string;
  /** A second level inside the stage, e.g. a pool name. Adapter-supplied; often null. */
  roundLabel: string | null;
  /** Complete, current or waiting. Derived from the stage's own completion rule. */
  status: StageStatus;
  /** Matches the stage has, or — for a generated fixture list — will have. */
  total: number;
  /** Matches decided. */
  completed: number;
  /** Matches still to decide. `total - completed`, so it can never disagree with them. */
  remaining: number;
  /** What to do next, when there is a next. */
  action: StageAction | null;
  /** A short frame for a stage with nothing to count yet. Adapter-supplied. */
  note: string | null;
  /** Known future slots that are waiting for their sources, rather than playable matches. */
  waitingMatches?: readonly { label: string; sourceA: string; sourceB: string }[];
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

/** Stage labels the placement pipeline prints. The component knows none of these. */
const ROUND_ONE = "Round 1";
const ROUND_TWO = "Round 2";
const KNOCKOUT = "Knockout";
const TOURNAMENT_COMPLETE = "Tournament Complete";

/** Shown on a stage that can be created right now, beside the button that creates it. */
const READY_TO_GENERATE = "Ready to generate";

/** Position inside an event, so the pipeline sorts as R1 → R2 → Knockout → Complete. */
const ORDER = { roundOne: 1, roundTwo: 2, knockout: 3, complete: 4 } as const;

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

function generateAction(label: string, scopeId: string): StageAction {
  return { kind: "generate", label: `Generate ${label}`, scopeId };
}

function enterResults(): StageAction {
  return { kind: "enter-results", label: "Enter Results", scopeId: null };
}

/** A row plus the position that orders it within its event. */
interface Draft extends StageProgressRow {
  order: number;
}

/**
 * Builds one row, deriving the status from the stage's own completion rule.
 *
 * `started` exists for the legacy pool rows, whose fixture list is known before any row is
 * created: six matches scheduled and none generated is "waiting with six to come", not "in
 * progress". Everywhere else, having a total means having rows.
 */
function stageRow(draft: {
  key: string;
  eventLabel: string | null;
  stageLabel: string;
  roundLabel?: string | null;
  order: number;
  total: number;
  completed: number;
  done: boolean;
  started?: boolean;
  action?: StageAction | null;
  note?: string | null;
  waitingMatches?: StageProgressRow["waitingMatches"];
}): Draft {
  const total = Math.max(0, draft.total);
  const completed = Math.min(Math.max(0, draft.completed), total);
  const started = draft.started ?? total > 0;
  const status: StageStatus = draft.done ? "completed" : started ? "current" : "waiting";

  return {
    key: draft.key,
    eventLabel: draft.eventLabel,
    stageLabel: draft.stageLabel,
    roundLabel: draft.roundLabel ?? null,
    order: draft.order,
    status,
    total,
    completed,
    remaining: total - completed,
    action: draft.action ?? null,
    note: draft.note ?? null,
    ...(draft.waitingMatches?.length ? { waitingMatches: draft.waitingMatches } : {}),
  };
}

/** What a set of tier draws adds up to, across every tier of one event. */
interface KnockoutTotals {
  total: number;
  completed: number;
  /** Draws that carry a bracket worth counting. */
  draws: number;
}

/**
 * Adds up an event's A/B/C/D brackets.
 *
 * A draw of N entrants plays N - 1 matches. That is exact rather than estimated — each match
 * eliminates exactly one entrant, so the bracket ends after N - 1 of them — which is why the
 * knockout stage can report a total before its later rounds exist. Byes are already excluded by
 * construction: a bracket of size B holding N entrants has B - N byes, and (B - 1) - (B - N) is
 * N - 1.
 */
function knockoutTotals(
  draws: readonly TierDraw[],
  matchesByDraw: Map<string, TierDrawMatch[]>,
): KnockoutTotals {
  let total = 0;
  let completed = 0;
  let counted = 0;

  for (const draw of draws) {
    if (draw.bracket_size <= 1 || draw.entrant_count <= 1) continue;
    counted += 1;
    total += draw.entrant_count - 1;
    completed += (matchesByDraw.get(draw.id) ?? []).filter(
      (match) => !match.is_bye && SETTLED.has(match.status),
    ).length;
  }

  return { total, completed, draws: counted };
}

/**
 * The placement pipeline: round one, round two and the knockout, per event.
 *
 * Reuses `buildCategoryView`, which is the same view model the Placement tab gates its generate
 * buttons on. Its `stage` is the domain's own answer to "what is next" — `seeding`, `round1`,
 * `round2` or `draws` — so it decides every status here rather than a second set of rules:
 * round one is complete once the stage has moved past it, and the placement stage is complete
 * once the gate is ready, which is the same condition that unlocks the draws.
 *
 * A category is a placement entry when it has entrants, and earns a knockout row when it has a
 * field big enough to be drawn or a draw that already exists. So a field of one, which has no
 * rounds and no bracket, contributes nothing — and a draw whose entrants were not passed in
 * still reports itself rather than vanishing.
 */
function placementRows(input: StageProgressInput, codeOf: (id: string) => string | null): Draft[] {
  const rows: Draft[] = [];
  const entrantsByCategory = groupBy(input.entrants ?? [], (row) => row.category_id);
  const matchesByCategory = groupBy(input.placementMatches ?? [], (row) => row.category_id);
  const drawsByCategory = groupBy(input.tierDraws ?? [], (row) => row.category_id);
  const tierMatchesByDraw = groupBy(input.tierMatches ?? [], (row) => row.draw_id);

  const categoryIds = new Set([...entrantsByCategory.keys(), ...drawsByCategory.keys()]);

  for (const categoryId of categoryIds) {
    const entrants = entrantsByCategory.get(categoryId) ?? [];
    const matches = matchesByCategory.get(categoryId) ?? [];
    const draws = drawsByCategory.get(categoryId) ?? [];
    const eventLabel = codeOf(categoryId);
    const view = entrants.length > 0 ? buildCategoryView(entrants, matches) : null;

    const knockout = knockoutTotals(draws, tierMatchesByDraw);
    const canKnockout = knockout.draws > 0 || (view?.roundOneExpected ?? false);

    // A void match is not playable, so it is not part of the progress a round reports.
    const roundOne = (view?.roundOne ?? []).filter((match) => match.status !== "void");
    const roundTwo = (view?.roundTwo ?? []).filter((match) => match.status !== "void");

    const roundOneDone = view?.stage === "round2" || view?.stage === "draws";
    const placementDone = view?.stage === "draws";

    const eventRows: Draft[] = [];

    if (view?.roundOneExpected) {
      const generated = roundOne.length > 0;
      let action: StageAction | null = null;
      let note: string | null = null;
      if (!generated) {
        // Nothing to generate until the seed order is frozen — the pairing needs it.
        if (view.seedsLocked) {
          action = generateAction(ROUND_ONE, categoryId);
          note = READY_TO_GENERATE;
        } else {
          note = "Seeds are not locked yet";
        }
      } else if (!roundOneDone) {
        action = enterResults();
      }

      eventRows.push(
        stageRow({
          key: `placement:${categoryId}:r1`,
          eventLabel,
          stageLabel: ROUND_ONE,
          order: ORDER.roundOne,
          total: roundOne.length,
          completed: completion(roundOne),
          done: roundOneDone,
          action,
          note,
        }),
      );
    }

    if (view?.roundTwoExpected) {
      const generated = roundTwo.length > 0;
      const existingKeys = new Set(view.roundTwo.map((m) => m.generation_key));
      const waitingMatches = view.roundTwoSlots
        .filter((s) => !existingKeys.has(s.key))
        .map((s) => ({
          label: `Match ${s.key.replace("r2-", "")}`,
          sourceA: `${s.outcome === "winner" ? "Winner" : "Loser"} of Round 1 match ${s.sourceAKey.replace("r1-", "")}`,
          sourceB: `${s.outcome === "winner" ? "Winner" : "Loser"} of Round 1 match ${s.sourceBKey.replace("r1-", "")}`,
        }));
      let action: StageAction | null = null;
      let note: string | null = null;
      if (!generated) {
        if (roundOneDone) {
          action = generateAction(ROUND_TWO, categoryId);
          note = READY_TO_GENERATE;
        } else {
          note = `Waiting on ${ROUND_ONE}`;
        }
      } else if (!placementDone) {
        action = enterResults();
      }

      eventRows.push(
        stageRow({
          key: `placement:${categoryId}:r2`,
          eventLabel,
          stageLabel: ROUND_TWO,
          order: ORDER.roundTwo,
          total: view.roundTwoSlots.length || roundTwo.length,
          started: generated,
          waitingMatches,
          completed: completion(roundTwo),
          done: placementDone,
          action,
          note,
        }),
      );
    }

    if (canKnockout) {
      // A draw row is the signal that the knockout exists, not a countable match inside it. A
      // field of two is drawn as two champion-only brackets, which hold no matches at all — so
      // asking for a total would leave the event offering to generate a knockout it already has,
      // and no terminal stage would ever arrive.
      const generated = draws.length > 0;
      const settled = generated && (knockout.total === 0 || knockout.completed >= knockout.total);
      let action: StageAction | null = null;
      let note: string | null = null;
      if (!generated) {
        if (placementDone) {
          action = generateAction(KNOCKOUT, categoryId);
          note = READY_TO_GENERATE;
        } else {
          // A field of two reaches the draws straight from round one, so name whichever round
          // this event actually has left to finish rather than a round it never plays.
          note = `Waiting on ${view?.roundTwoExpected ? ROUND_TWO : ROUND_ONE}`;
        }
      } else if (!settled) {
        action = enterResults();
      }

      eventRows.push(
        stageRow({
          key: `knockout:${categoryId}`,
          eventLabel,
          stageLabel: KNOCKOUT,
          order: ORDER.knockout,
          total: knockout.total,
          completed: knockout.completed,
          done: settled,
          action,
          note,
        }),
      );
    }

    // The terminal stage names itself rather than adding a count: there is nothing left to
    // measure, which is the whole point of it.
    if (view && eventRows.length > 0 && eventRows.every((row) => row.status === "completed")) {
      eventRows.push(
        stageRow({
          key: `complete:${categoryId}`,
          eventLabel,
          stageLabel: TOURNAMENT_COMPLETE,
          order: ORDER.complete,
          total: 0,
          completed: 0,
          done: true,
        }),
      );
    }

    rows.push(...eventRows);
  }

  return rows;
}

/**
 * The legacy round-robin format: one row per pool, one per knockout draw round.
 *
 * A pool's fixture list is generated rather than forecast, so its outstanding count comes from
 * `buildRoundRobin` — the same routine that would create the matches — and its readiness from
 * `poolIsComplete`, the same check the Draws tab gates on. Its status still follows the rows
 * that exist: six matches known and none created is waiting, not in progress.
 *
 * The draw rounds report progress only. Their generation belongs to the Draws tab, so no action
 * is offered here.
 */
function roundRobinRows(input: StageProgressInput, codeOf: (id: string) => string | null): Draft[] {
  const rows: Draft[] = [];
  const entriesByPool = groupBy(input.poolEntries ?? [], (row) => row.pool_id);
  const matchesByPool = groupBy(input.poolMatches ?? [], (row) => row.pool_id);

  for (const pool of input.pools ?? []) {
    const teamIds = (entriesByPool.get(pool.id) ?? []).map((entry) => entry.team_id);
    if (teamIds.length < 2) continue;
    const poolMatches = matchesByPool.get(pool.id) ?? [];
    const playable = poolMatches.filter((match) => match.status !== "void");
    const expected = buildRoundRobin({ entrants: teamIds, groupKey: pool.id }).length;
    const complete = poolIsComplete(teamIds, poolMatches);

    rows.push(
      stageRow({
        key: `pool:${pool.id}`,
        eventLabel: codeOf(pool.category_id),
        stageLabel: "Group",
        roundLabel: pool.name,
        order: 1,
        total: expected,
        completed: completion(playable),
        done: complete,
        started: playable.length > 0,
        // A group with no matches yet has nothing to score, so it offers no action; its
        // outstanding count is the generator's fixture list rather than a missing stage.
        action: complete || playable.length === 0 ? null : enterResults(),
        note: complete ? "Ready for the draw" : null,
      }),
    );
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
      const completed = completion(playable);

      rows.push(
        stageRow({
          key: `draw:${draw.id}:r${round}`,
          eventLabel: codeOf(draw.category_id),
          stageLabel: draw.tier ? `Draw ${draw.tier}` : "Draw",
          roundLabel: `Round ${round}`,
          order: 2,
          total: playable.length,
          completed,
          done: playable.length > 0 && completed === playable.length,
        }),
      );
    }
  }

  return rows;
}

/**
 * Every stage row for the tournament, in event order and then down the pipeline.
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

  const drafts = [...placementRows(input, codeOf), ...roundRobinRows(input, codeOf)];

  return drafts
    .sort(
      (a, b) =>
        (orderByCode.get(a.eventLabel ?? "") ?? 0) - (orderByCode.get(b.eventLabel ?? "") ?? 0) ||
        (a.eventLabel ?? "").localeCompare(b.eventLabel ?? "") ||
        a.order - b.order ||
        (a.roundLabel ?? "").localeCompare(b.roundLabel ?? ""),
    )
    .map(({ order: _order, ...row }) => row);
}
