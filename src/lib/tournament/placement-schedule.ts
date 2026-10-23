/**
 * Day planning for the two-round placement format.
 *
 * This is the placement format's counterpart to `planDay` in `actions.ts`, and it
 * exists as a separate module for the same reason the tables are separate: the
 * legacy planner reads `pool_matches` and `draw_matches` by name, and teaching it
 * about a second pair of tables would mean a function that has to know which
 * format it is looking at.
 *
 * What is shared is deliberate and narrow: the scheduling core and day runner, the
 * row-to-item conversion, the plan diff and the summary shape are all imported rather
 * than reimplemented. The plan carries no finish forecast: the only finish it reports is
 * the last end among the matches it actually placed.
 *
 * Two conversions are worth calling out:
 *
 *   * A placement match carries two *entrant* ids, and an entrant points at a
 *     team. Player ids therefore need an extra hop that the legacy tables do not.
 *     Getting this wrong would not fail loudly; the scheduler would just see a
 *     match with no players and mark it awaiting teams.
 *   * `placement_matches.prerequisite_ids` is the held entrant's ordering rule
 *     ("my second make-up waits for my first"). It maps straight onto the
 *     scheduler's `dependencies`, which is what makes the held entrant's two matches
 *     sequential rather than simultaneous.
 */

import { supabase } from "@/integrations/supabase/client";

import { compareIds, normalizeBreaks, relateToDecided } from "@/lib/scheduling";
import type {
  BaselineSlot,
  CandidateInterval,
  DecidedInterval,
  RestConstraint,
} from "@/lib/scheduling";

import type { ScheduleSummary } from "./actions";
import type {
  Court,
  PlacementEntrant,
  PlacementMatch,
  PlacementStageName,
  Team,
  TierDraw,
  TierDrawMatch,
  Tournament,
  TournamentDay,
  TournamentDayBreak,
} from "./data";
import { diffPlan, type SchedulePlanDiff } from "./schedule-diff";
import { MIN_ENTRANTS_FOR_ROUND_TWO } from "./placement-actions";
import { bracketRoundCount, isTierMatchReady } from "./tier-draw";
import {
  breakWindowsFor,
  courtsAddedToDays,
  courtsForDay,
  dayWindowBounds,
  runPlanDays,
  sliceRowsByDay,
  type DaySlice,
  type PlacementDayFill,
} from "./scheduling/day-plan";
import type { DayOneSchedulerOptions } from "./scheduling/policy";
import {
  buildPlayerLookup,
  placementItems,
  tierItems,
  type StageItem,
} from "./scheduling/stage-items";
import type { ScheduledSlot } from "./scheduling/types";

const MINUTE = 60_000;

/** A still-`scheduled` row, reduced to what the freeze decision needs. */
export interface CommittedMatch {
  id: string;
  /** The court the desk currently has it on, as a court number; null when none is recorded. */
  courtNumber: number | null;
  /** When the desk currently expects it, in epoch ms; null when none is recorded. */
  start: number | null;
}

/**
 * The still-`scheduled` rows a rebuild must not move: the next committed match on each court.
 *
 * A rebuild that reconsiders everything can move a match that is about to be played, and the
 * further down the running order the desk has read, the worse that is. The guarantee here is
 * deliberately the smallest useful one: whatever is next on each court stays exactly where it is,
 * and nothing else is promised. `horizonMinutes` extends it to a window measured from `now`, and
 * defaults to zero because a longer freeze is only ever justified by a measured need.
 *
 * A row with no court or no time cannot be protected — there is nothing to hold — so it is left
 * out rather than guessed at.
 */
export function frozenMatchIdsFor(input: {
  committed: readonly CommittedMatch[];
  now: number;
  horizonMinutes?: number | undefined;
}): string[] {
  const horizonMinutes = Math.max(0, input.horizonMinutes ?? 0);
  const horizonEnd = input.now + horizonMinutes * MINUTE;

  /** The earliest committed row on each court, which is the one the desk is about to reach. */
  const nextByCourt = new Map<number, CommittedMatch>();
  for (const match of input.committed) {
    if (match.courtNumber == null || match.start == null) continue;
    const current = nextByCourt.get(match.courtNumber);
    if (
      current == null ||
      match.start < current.start! ||
      (match.start === current.start && match.id < current.id)
    ) {
      nextByCourt.set(match.courtNumber, match);
    }
  }

  const frozen = new Set([...nextByCourt.values()].map((match) => match.id));
  if (horizonMinutes > 0) {
    for (const match of input.committed) {
      if (match.start != null && match.start <= horizonEnd) frozen.add(match.id);
    }
  }
  return [...frozen].sort();
}

/**
 * The day a `scheduled_time` falls into, by the rule `sliceRowsByDay` uses: the last day whose
 * window had already opened when it did.
 *
 * Duplicated in miniature here rather than reused, because this runs before any items exist and
 * only ever needs the day's id. The two must agree; `planPlacementSchedule` passing a frozen match
 * to the wrong day would pin it where no day plays it, which the court check below then catches.
 */
function dayOwning(start: number, orderedDays: readonly TournamentDay[]): number {
  const byWindow = [...orderedDays].sort((a, b) => {
    const startA = dayWindowBounds(a).start;
    const startB = dayWindowBounds(b).start;
    if (startA !== startB) return startA - startB;
    return a.day_number - b.day_number;
  });
  let index = 0;
  for (let candidate = 0; candidate < byWindow.length; candidate += 1) {
    if (dayWindowBounds(byWindow[candidate]!).start <= start) index = candidate;
  }
  return index;
}

/**
 * An item's own rest rules, in the shape the core's `relateToDecided` reads.
 *
 * `placementItems` and `tierItems` already write each row's stage rest gap onto `restAfterMinutes`,
 * so this hands the freeze the same numbers `resolveStageItems` would apply to a solver run. It
 * copies the fields rather than spreading the whole item so a later addition to `StageItem` cannot
 * silently flow into the rest relation.
 */
function restRulesOf(constraint: RestConstraint): RestConstraint {
  return {
    ...(constraint.restAfterMinutes === undefined
      ? {}
      : { restAfterMinutes: constraint.restAfterMinutes }),
    ...(constraint.restBeforeMinutes === undefined
      ? {}
      : { restBeforeMinutes: constraint.restBeforeMinutes }),
    ...(constraint.restOverrides === undefined
      ? {}
      : { restOverrides: constraint.restOverrides }),
  };
}

export {
  breakWindowsFor,
  courtsAddedToDays,
  courtsForDay,
  dayWindowBounds,
  sliceRowsByDay,
  type DaySlice,
  type PlacementDayFill,
  type StageItem,
};

export interface PlacementSlotPayload {
  match_id: string;
  scheduled_time: string;
  court_id: string;
}

/**
 * A whole tournament's schedule: every day, both stages, one queue.
 *
 * Fixed (reported, in-progress and walkover) matches are left out of the payloads,
 * which is what makes applying a plan a rebuild rather than a rewrite: the writer
 * clears and re-sets only rows still in `scheduled`.
 */
export interface PlacementSchedulePlan {
  tournamentId: string;
  /** Every slot in the plan, across every day and both stages. */
  slots: ScheduledSlot[];
  /** Rows the desk has already decided: reported, in progress or a walkover. */
  fixedMatchIds: string[];
  /**
   * Rows the planner pinned only to keep the near term still, still `scheduled` as far as the desk
   * is concerned.
   *
   * Kept apart from `fixedMatchIds` on purpose. Both are immovable for the solver, but a frozen row
   * is still the writer's to place and still the desk's to see: `payloadFor` must name it, or
   * `uncoveredScheduledMatches` would report it as dropped, and the diff must report it as
   * unchanged, or a rebuild would look as though it had touched it.
   */
  frozenMatchIds: string[];
  blocked: string[];
  awaitingTeams: string[];
  diff: SchedulePlanDiff;
  summary: ScheduleSummary;
  days: PlacementDayFill[];
  /**
   * Split by stage because the writer is stage-scoped: `apply_placement_day_schedule`
   * takes one stage and clears only that stage's rows. Keeping `p_stage` means one
   * plan becomes two calls rather than a migration to widen the RPC.
   */
  placementSlotPayload: PlacementSlotPayload[];
  knockoutSlotPayload: PlacementSlotPayload[];
  /**
   * The rows each stage's call will CLEAR, captured as the plan was computed.
   *
   * `apply_placement_day_schedule` wipes every `scheduled` row of its stage and then
   * re-sets whatever the payload names, so a row that is cleared and not named is
   * left with no court and no time — the RPC's own completeness guard then fails the
   * whole transaction. Carrying these ids lets the client check that invariant
   * before it sends anything, which turns "the rebuild left a match behind" into a
   * message that says which match and why.
   */
  placementScheduledIds: string[];
  knockoutScheduledIds: string[];
  /**
   * The slots for matches that held no court or time before this plan, split by stage. This is
   * what `place_ready_matches` writes: the additive path, which names only the new placements and
   * clears nothing. In `place-ready` mode it is the whole payload.
   */
  placementNewPayload: PlacementSlotPayload[];
  knockoutNewPayload: PlacementSlotPayload[];
  /**
   * Why each match the plan left without a slot has none, in the host's terms.
   *
   * Covers `blocked` and `awaitingTeams` alike. The Schedule page words a notice from these, and
   * the automatic pass uses them to tell "ask the organiser" from "nothing to ask".
   */
  unplaced: UnplacedMatch[];
  /** Why the scheduler could not place something, for the desk-facing error. */
  blockedReason: string | null;
}

/**
 * - `no_courts`: no day has a court, so nothing can be placed anywhere.
 * - `past_closing`: the match would finish after the last day's closing time (automatic placement
 *   only; a rebuild may overrun and forecasts it instead).
 * - `held_behind_placement`: a knockout waits because a placement match has no slot yet.
 * - `data`: a prerequisite the plan never schedules, matches waiting on each other, or an entrant
 *   with no team. Pressing anything again will not change it.
 * - `no_slot`: no court and free pair of players coincide (rebuild mode's generic cause).
 * - `out_of_order`: placing it would put it after a published match that waits on it (or it waits on
 *   one such), so it is left for a rebuild to reorder (automatic placement only).
 */
export type UnplacedReason =
  | "no_courts"
  | "past_closing"
  | "held_behind_placement"
  | "data"
  | "no_slot"
  | "out_of_order";

export interface UnplacedMatch {
  matchId: string;
  reason: UnplacedReason;
}

export interface PlanPlacementScheduleInput {
  tournament: Tournament;
  /** Every day. Order does not matter; they are sorted by day_number. */
  days: readonly TournamentDay[];
  /** The whole court pool. Each day narrows it through `dayCourtIds`. */
  allCourts: readonly Court[];
  /** Courts per day id. A day with no entry plays on every court. */
  dayCourtIds?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /** Breaks per day id. */
  breaksByDayId?: ReadonlyMap<string, readonly TournamentDayBreak[]> | undefined;
  teams: readonly Team[];
  entrants: readonly PlacementEntrant[];
  draws: readonly TierDraw[];
  placementMatches: readonly PlacementMatch[];
  tierMatches: readonly TierDrawMatch[];
  categoryOrder: ReadonlyMap<string, number>;
  options?: DayOneSchedulerOptions;
  /** Injectable clock, so a rebuild's floor is testable rather than wall-clock. */
  now?: number;
  /**
   * Minutes of near-term work to pin, measured from `now`, on top of the next committed match on
   * each court.
   *
   * Defaults to 0. The per-court freeze is the guarantee; this is the knob for a measured need
   * rather than the starting point.
   */
  freezeHorizonMinutes?: number | undefined;
  /**
   * `rebuild` (the default) re-solves every unplayed match. `place-ready` never moves a match that
   * already holds a court and a time: each one is an immovable anchor, wherever it sits (past, in
   * a break, over a close), and only matches with no court or time are placed around them. It is
   * what lets a newly ready match be slotted in without disturbing a published time.
   */
  mode?: "rebuild" | "place-ready" | undefined;
}

/**
 * Plans the whole tournament as one queue, without writing anything.
 *
 * The queue is the placement stage and then the knockouts. It fills each day in
 * turn — day one first, spilling into day two, and so on — so a day's stage mix is
 * an outcome rather than an input, and a day may carry the tail of one stage and
 * the head of the next.
 *
 * The stage barrier is real rather than advisory: the knockouts are only placed on
 * a day once every placement match has a slot. But it is also already guaranteed
 * by the generators, because round two cannot exist until every round one result
 * is in. A knockout bracket exists in full from its draw, but only the matches whose two
 * sides are known are schedulable (`tierItems` drops the rest), and a child slot is filled
 * only when its feeders finish. So this still needs no round-ordering logic of its own:
 * scheduling everything that is ready is the same thing as scheduling in order.
 *
 * A stage's duration and rest gap come from the tournament's group and knockout
 * columns; the placement stage reuses the group columns rather than adding a third
 * pair, because it occupies the same slot in the day the legacy group stage did.
 */
export function planPlacementSchedule(input: PlanPlacementScheduleInput): PlacementSchedulePlan {
  const {
    tournament,
    days,
    allCourts,
    dayCourtIds,
    breaksByDayId,
    teams,
    entrants,
    draws,
    placementMatches,
    tierMatches,
    categoryOrder,
    options,
    now = Date.now(),
    freezeHorizonMinutes = 0,
  } = input;
  const placeReady = input.mode === "place-ready";

  if (!days.length) {
    throw new Error("A tournament needs at least one day before a schedule can be built.");
  }
  if (!allCourts.length) throw new Error("Load the court list before building a schedule.");

  const orderedDays = [...days].sort((a, b) => a.day_number - b.day_number);
  const nextWholeMinute = Math.ceil(now / MINUTE) * MINUTE;

  const placementSlot = tournament.group_slot_minutes;
  const placementRest = tournament.group_rest_gap_minutes;
  const knockoutSlot = tournament.knockout_slot_minutes;
  const knockoutRest = tournament.knockout_rest_gap_minutes;

  const playerLookup = buildPlayerLookup(entrants, teams);
  const courtNumberById = new Map(allCourts.map((court) => [court.id, court.number]));
  const drawCategory = new Map(draws.map((draw) => [draw.id, draw.category_id]));

  const existing = [...placementMatches, ...tierMatches];
  // One rebuild flag for the whole tournament, not per stage: a plan that has to
  // respect what has already been played must do so on every day it touches.
  const isRebuild = existing.some(
    (match) => match.status !== "void" && match.scheduled_time != null,
  );

  /**
   * The stage-closing signal, both halves, from the format's own pipeline knowledge.
   *
   * A stage's successor usually does not exist as a row yet — round two is generated only once every
   * round-one result is in — so "what does finishing this stage release?" cannot be read off the
   * matches. It is derived from the same predicates the generators use: the field size decides
   * whether a placement category has a round two, and the bracket size decides a draw's depth.
   * Nothing here re-implements a pairing rule; it only asks the existing ones.
   */
  const activeEntrantsPerCategory = new Map<string, number>();
  for (const entrant of entrants) {
    if (entrant.excluded) continue;
    activeEntrantsPerCategory.set(
      entrant.category_id,
      (activeEntrantsPerCategory.get(entrant.category_id) ?? 0) + 1,
    );
  }
  const roundTwoCategories = new Set(
    [...activeEntrantsPerCategory]
      .filter(([, count]) => count >= MIN_ENTRANTS_FOR_ROUND_TWO)
      .map(([categoryId]) => categoryId),
  );
  const drawRoundCount = new Map(
    draws.map((draw) => [draw.id, bracketRoundCount(draw.bracket_size)]),
  );

  // Round one and round two are one stage, so they share a duration and a queue
  // slot; the queue has two printers, not three.
  const placementRaw = placementItems({
    matches: placementMatches,
    playerLookup,
    courtNumberById,
    categoryOrder,
    roundTwoCategories,
    slotMinutes: placementSlot,
    restGap: placementRest,
    now,
  });
  const knockoutRaw = tierItems({
    matches: tierMatches,
    drawCategory,
    drawRoundCount,
    playerLookup,
    courtNumberById,
    categoryOrder,
    slotMinutes: knockoutSlot,
    restGap: knockoutRest,
    now,
  });

  /**
   * The near-term freeze, resolved here rather than by the day runner.
   *
   * A `scheduled` row is already on a court, and the writer's completeness guard demands that every
   * such row still be named by the payload. Pinning one onto a court its own day does not play would
   * turn it into a participant anchor with no slot of its own, so the row would vanish from the
   * payload and `applyPlacementSchedulePlan` would refuse the build. The day that owns the row and
   * its courts are both known here, so the two questions are answered together and a row that cannot
   * be honoured on its own court is simply left movable instead.
   *
   * The same guard applies to the court's decided history: a match that has since overrun into this
   * window cannot be pinned against it, because two fixed matches overlapping on one resource is a
   * physical impossibility the problem validator rejects outright.
   *
   * A pin is a **validity** claim as well as "do not move the match the desk is about to call". A
   * frozen item is `fixed: true` in the problem, and the validators exempt a fixed match from the
   * floor, the hard end, breaks, availability and rest — an exemption meant for *decided history*,
   * which a pin is not. A pin whose time the day has already passed, that sleeps inside a break,
   * that finishes after a non-final day's close, or that breaks rest with decided history or with
   * another pin is therefore not taken: the row stays movable and the solver re-places it. Kept as
   * it stands, the freeze would preserve a time the solver itself would have refused to choose.
   */
  const committedById = new Map<string, BaselineSlot>();
  for (const match of existing) {
    if (match.status !== "scheduled" || !match.court_id || !match.scheduled_time) continue;
    committedById.set(match.id, {
      matchId: match.id,
      start: new Date(match.scheduled_time).getTime(),
      resourceId: match.court_id,
    });
  }
  /**
   * Rows `place-ready` must leave exactly where they are but cannot hold as a pin (an illegal or
   * colliding one). They are taken out of the problem entirely: never moved, never planned.
   */
  const dropIds = new Set<string>();
  const release = (item: StageItem): void => {
    if (placeReady) dropIds.add(item.id);
  };
  const freezeIds = placeReady
    ? new Set(committedById.keys())
    : new Set(
    frozenMatchIdsFor({
      committed: [...committedById.values()].map((slot) => ({
        id: slot.matchId,
        courtNumber: courtNumberById.get(slot.resourceId) ?? null,
        start: slot.start,
      })),
      now,
      horizonMinutes: freezeHorizonMinutes,
    }),
  );

  /** The windows already decided on each court *number*, for the pinned-match legality check. */
  const decidedWindowsByCourt = new Map<number, { start: number; end: number }[]>();
  for (const item of [...placementRaw, ...knockoutRaw]) {
    if (!item.fixed || item.courtNumber == null || item.start == null || item.end == null) continue;
    const list = decidedWindowsByCourt.get(item.courtNumber) ?? [];
    list.push({ start: item.start, end: item.end });
    decidedWindowsByCourt.set(item.courtNumber, list);
  }

  /**
   * The decided history a pin must not contradict: every fixed (reported, in-progress or walkover)
   * occupancy, with the rest gap its own stage gives it.
   */
  interface Occupancy {
    start: number;
    end: number;
    courtNumber: number | null;
    participantIds: readonly string[];
    rest: RestConstraint;
  }
  const decidedOccupancies: Occupancy[] = [];
  for (const item of [...placementRaw, ...knockoutRaw]) {
    if (!item.fixed || item.start == null || item.end == null) continue;
    decidedOccupancies.push({
      start: item.start,
      end: item.end,
      courtNumber: item.courtNumber ?? null,
      participantIds: item.participantIds,
      rest: restRulesOf(item),
    });
  }

  /** The last day a plan may overrun on, which is the last day that has courts. */
  const lastCourtDayId =
    [...orderedDays]
      .filter((day) => courtsForDay(allCourts, dayCourtIds?.get(day.id) ?? new Set()).length > 0)
      .pop()?.id ?? null;

  /** A row the freeze would pin, with the window its current time implies. */
  interface FreezeCandidate {
    item: StageItem;
    start: number;
    end: number;
  }

  const rawById = new Map([...placementRaw, ...knockoutRaw].map((item) => [item.id, item]));
  /** Rows the freeze would pin, minus the ones whose current time is no longer legal. */
  const candidates: FreezeCandidate[] = [];
  for (const item of [...placementRaw, ...knockoutRaw]) {
    if (item.fixed || !freezeIds.has(item.id)) continue;
    const committed = committedById.get(item.id);
    if (!committed) continue;
    // A rebuild does not pin a match that still waits on an unplayed one. The solver can move that
    // prerequisite but cannot give it a deadline, so a pinned dependent would leave it only the room
    // after the pin: the held entrant's second make-up match, kept at 11:35, put the first at 11:50.
    // Unpinned, the pair is placed in order. (`place-ready` pins everything and checks the order
    // afterwards, since a published time there is not ours to release.)
    if (
      !placeReady &&
      (item.dependencies ?? []).some((id) => {
        const prerequisite = rawById.get(id);
        return prerequisite != null && !prerequisite.fixed;
      })
    ) {
      continue;
    }
    const owningDay = orderedDays[dayOwning(committed.start, orderedDays)];
    if (!owningDay) {
      release(item);
      continue;
    }
    const dayCourts = courtsForDay(allCourts, dayCourtIds?.get(owningDay.id) ?? new Set());
    if (!dayCourts.some((court) => court.id === committed.resourceId)) {
      release(item);
      continue;
    }

    const start = committed.start;
    const end = start + item.durationMinutes * MINUTE;

    if (!placeReady) {
      // A pin is the match the desk is about to call, and one the day has already passed is not
      // that match any more. Releasing it lets the solver pull it forward to the floor rather than
      // keeping a stale time the desk can no longer act on.
      if (start < nextWholeMinute) continue;
      // A match may not sleep inside a break. The day runner steps movable work over breaks, so a
      // pin that kept a break-violating time would preserve exactly what the run exists to fix.
      const breaks = normalizeBreaks(
        breakWindowsFor(owningDay, breaksByDayId?.get(owningDay.id)),
        dayWindowBounds(owningDay).end,
      );
      if (breaks.some((brk) => start < brk.end && brk.start < end)) continue;
      // Every day but the last is a wall, and the last day is where a long plan is allowed to
      // overrun. So a pin crossing a non-final day's close is invalid; the same on the final day is
      // left alone.
      if (owningDay.id !== lastCourtDayId && end > dayWindowBounds(owningDay).end) continue;
    }
    // The court's decided history, kept exactly as it was: two fixed matches on one resource is a
    // physical impossibility the problem validator rejects.
    const busy = decidedWindowsByCourt.get(item.courtNumber ?? -1) ?? [];
    if (busy.some((window) => start < window.end && window.start < end)) {
      release(item);
      continue;
    }

    candidates.push({ item, start, end });
  }

  /**
   * Whether pinning `candidate` would collide with `occupancy`: same court at overlapping times, or
   * a shared player inside the forbidden rest window.
   *
   * The rest maths and the direction of the comparison both come from the core's own
   * `relateToDecided`, so the freeze cannot invent a rule the solver would not apply. Each item
   * carries the gap of its own stage, which is the number `placementItems`/`tierItems` wrote and the
   * one `resolveStageItems` applies when both items are in the same stage — the only case where a
   * pin is decided against another row of the same run.
   */
  const collidesWith = (candidate: FreezeCandidate, occupancy: Occupancy): boolean => {
    if (
      candidate.item.courtNumber != null &&
      occupancy.courtNumber === candidate.item.courtNumber &&
      candidate.start < occupancy.end &&
      occupancy.start < candidate.end
    ) {
      return true;
    }
    const shared = candidate.item.participantIds.filter((id) =>
      occupancy.participantIds.includes(id),
    );
    if (!shared.length) return false;
    const interval: CandidateInterval = {
      durationMinutes: candidate.item.durationMinutes,
      ...restRulesOf(candidate.item),
    };
    const decided: DecidedInterval = {
      start: occupancy.start,
      end: occupancy.end,
      ...occupancy.rest,
    };
    return shared.some(
      (id) => relateToDecided(candidate.start, interval, decided, id) === "conflict",
    );
  };

  /**
   * The rows that actually get pinned. A candidate must clear decided history and every pin already
   * accepted before it. Sorting by time then id means two pins that conflict resolve to the earlier
   * one — a held pair of reflow rows is half-released rather than both kept, and the later row goes
   * back to the solver.
   */
  const acceptedPins: Occupancy[] = [];
  const frozenWindow = new Map<string, { start: number; end: number }>();
  for (const candidate of [...candidates].sort(
    (a, b) => a.start - b.start || compareIds(a.item.id, b.item.id),
  )) {
    if (
      decidedOccupancies.some((occupancy) => collidesWith(candidate, occupancy)) ||
      acceptedPins.some((occupancy) => collidesWith(candidate, occupancy))
    ) {
      release(candidate.item);
      continue;
    }
    acceptedPins.push({
      start: candidate.start,
      end: candidate.end,
      courtNumber: candidate.item.courtNumber ?? null,
      participantIds: candidate.item.participantIds,
      rest: restRulesOf(candidate.item),
    });
    frozenWindow.set(candidate.item.id, { start: candidate.start, end: candidate.end });
  }

  const applyFreeze = (item: StageItem): StageItem => {
    const window = frozenWindow.get(item.id);
    return window
      ? { ...item, frozen: true, fixed: true, start: window.start, end: window.end }
      : item;
  };

  /**
   * An item taken out of the problem must not stay named as somebody's dependency: the problem rejects a
   * dependency on a match it does not contain, which failed whole plans (a held entrant's second make-up
   * match depends on the first). The dependency becomes what it meant, a floor: the dependent may not
   * start before the dropped match is due to end where it stands.
   */
  const withoutDropped = (item: StageItem): StageItem => {
    const dropped = (item.dependencies ?? []).filter((id) => dropIds.has(id));
    if (!dropped.length) return item;
    let floor = item.eligibleFrom ?? 0;
    for (const id of dropped) {
      const gone = rawById.get(id);
      const at = committedById.get(id)?.start;
      if (gone && at != null) floor = Math.max(floor, at + gone.durationMinutes * MINUTE);
    }
    return {
      ...item,
      dependencies: (item.dependencies ?? []).filter((id) => !dropIds.has(id)),
      ...(floor ? { eligibleFrom: floor } : {}),
    };
  };

  const placementAll = placementRaw
    .filter((item) => !dropIds.has(item.id))
    .map(withoutDropped)
    .map(applyFreeze);
  const knockoutAll = knockoutRaw
    .filter((item) => !dropIds.has(item.id))
    .map(withoutDropped)
    .map(applyFreeze);

  const run = runPlanDays({
    orderedDays,
    allCourts,
    ...(dayCourtIds ? { dayCourtIds } : {}),
    ...(breaksByDayId ? { breaksByDayId } : {}),
    placementAll,
    knockoutAll,
    placementSlotMinutes: placementSlot,
    placementRestGapMinutes: placementRest,
    knockoutSlotMinutes: knockoutSlot,
    knockoutRestGapMinutes: knockoutRest,
    isRebuild,
    nextWholeMinute,
    strictClose: placeReady,
    ...(options ? { options } : {}),
    ...(committedById.size ? { baselineByMatchId: committedById } : {}),
  });

  const everything = [...placementAll, ...knockoutAll];
  /**
   * Two sets, not one. `frozenMatchIds` is the planner's own pin, `fixedMatchIds` is decided
   * history; only the second may be excluded from the payload and from the diff. See
   * `PlacementSchedulePlan.frozenMatchIds`.
   */
  const frozenSet = new Set(everything.filter((item) => item.frozen === true).map((item) => item.id));
  const fixedSet = new Set(
    everything.filter((item) => item.fixed && item.frozen !== true).map((item) => item.id),
  );
  const { blocked, awaitingTeams } = partitionUnscheduled(
    [...run.placementUnscheduled, ...run.knockoutUnscheduled],
    everything,
  );

  // Described from the final set rather than from whichever run stopped first. The
  // old wording was that run's: "No future event can make 1 remaining match(es)
  // eligible", which named a count that could disagree with the list printed under
  // it and never said what was actually wrong.
  const blockedReason = blocked.length
    ? explainBlocked(blocked, {
        items: everything,
        scheduledIds: new Set(run.allSlots.map((slot) => slot.matchId)),
        heldByPlacement:
          run.placementUnscheduled.length > 0 ? new Set(run.knockoutUnscheduled) : new Set(),
      })
    : null;

  const unplaced = classifyUnplaced({
    blocked,
    awaitingTeams,
    items: everything,
    scheduledIds: new Set(run.allSlots.map((slot) => slot.matchId)),
    placementUnscheduled: new Set(run.placementUnscheduled),
    daysWithCourts: run.daysWithCourts,
    strictClose: placeReady,
  });

  const diff = diffPlan(existing, run.allSlots, fixedSet, courtNumberById);
  diff.unplaceable = blocked;

  const summary: ScheduleSummary = {
    placed: diff.placedCount,
    anchorCount: fixedSet.size,
    movedCount: diff.movedCount,
    unscheduled: blocked.length,
    awaitingTeams: awaitingTeams.length,
    utilization: run.totalCapacityMinutes > 0 ? run.usedMinutes / run.totalCapacityMinutes : 0,
    remainingUtilization: run.lastDiagnostics?.remainingWindowUtilization ?? null,
    // Lateness only. The unscheduled list is the incompleteness signal and carries it on its own,
    // so a day that closes on time but cannot place everything reports no overrun. Folding the two
    // together used to make an incomplete plan claim it ran past the day end.
    overrun: run.days.some((fill) => fill.overrunMinutes > 0),
    projectedFinish: run.lastFinishMs != null ? new Date(run.lastFinishMs).toISOString() : null,
    // The rebuild no longer compares two finishes: the plan's own last finish is the only
    // finish there is, and the per-day change table is what shows how the rebuild differs.
    currentProjectedFinish: null,
    projectedFinishDeltaMinutes: null,
    overrunMinutes:
      run.lastFinishMs != null && run.lastPlanningEndMs > 0
        ? Math.max(0, Math.round((run.lastFinishMs - run.lastPlanningEndMs) / MINUTE))
        : 0,
    ...(run.lastDiagnostics ? { diagnostics: run.lastDiagnostics } : {}),
  };

  const payloadFor = (stageIds: ReadonlySet<string>): PlacementSlotPayload[] =>
    run.allSlots
      .filter((slot) => stageIds.has(slot.matchId) && !fixedSet.has(slot.matchId))
      .map((slot) => ({
        match_id: slot.matchId,
        scheduled_time: slot.start.toISOString(),
        court_id: slot.courtId,
      }));

  /**
   * `place-ready` only: new slots that would sit on the wrong side of a published time.
   *
   * A published match is an anchor, and the solver gives a movable prerequisite no deadline, so a
   * prerequisite placed after its already-published dependent comes out *behind* it - the held
   * entrant's first make-up match at 11:50 behind the second at 11:35. Writing that is what set the
   * live reflow chasing a contradiction. Such a slot is dropped and reported as `out_of_order`, and so
   * is anything that waits on a dropped one: a rebuild, which may reorder, is the way out.
   */
  const outOfOrder = new Set<string>();
  if (placeReady) {
    const fresh = new Map(
      run.allSlots
        .filter((slot) => !fixedSet.has(slot.matchId) && !committedById.has(slot.matchId))
        .map((slot) => [slot.matchId, slot]),
    );
    for (const [dependentId, published] of committedById) {
      for (const prerequisiteId of rawById.get(dependentId)?.dependencies ?? []) {
        const slot = fresh.get(prerequisiteId);
        if (slot && slot.end.getTime() > published.start) outOfOrder.add(prerequisiteId);
      }
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of fresh.keys()) {
        if (outOfOrder.has(id)) continue;
        if ((rawById.get(id)?.dependencies ?? []).some((dep) => outOfOrder.has(dep))) {
          outOfOrder.add(id);
          grew = true;
        }
      }
    }
    for (const id of [...outOfOrder].sort()) unplaced.push({ matchId: id, reason: "out_of_order" });
  }

  /** Slots for matches that held no court or time before: the additive writer's whole input. */
  const newPayloadFor = (stageIds: ReadonlySet<string>): PlacementSlotPayload[] =>
    run.allSlots
      .filter(
        (slot) =>
          stageIds.has(slot.matchId) &&
          !fixedSet.has(slot.matchId) &&
          !committedById.has(slot.matchId) &&
          !outOfOrder.has(slot.matchId),
      )
      .map((slot) => ({
        match_id: slot.matchId,
        scheduled_time: slot.start.toISOString(),
        court_id: slot.courtId,
      }));

  // The rows the writer is about to clear, which the payloads above must therefore
  // cover. Byes and `void` rows are excluded because the RPC excludes them too.
  const placementScheduledIds = placementMatches
    .filter((match) => match.status === "scheduled")
    .map((match) => match.id);
  const knockoutScheduledIds = tierMatches
    .filter(
      (match) =>
        match.status === "scheduled" &&
        // The whole bracket exists from the draw, so a slot still waiting on a feeder is
        // scheduled in name only: it has no court or time to lose, and the writer's
        // completeness check (mirrored in SQL) ignores it.
        isTierMatchReady({
          entrantAId: match.entrant_a_id,
          entrantBId: match.entrant_b_id,
          isBye: match.is_bye,
        }),
    )
    .map((match) => match.id);

  return {
    tournamentId: tournament.id,
    slots: run.allSlots,
    fixedMatchIds: [...fixedSet],
    frozenMatchIds: [...frozenSet].sort(),
    blocked,
    awaitingTeams,
    diff,
    summary,
    days: run.days,
    placementSlotPayload: payloadFor(new Set(placementAll.map((item) => item.id))),
    knockoutSlotPayload: payloadFor(new Set(knockoutAll.map((item) => item.id))),
    placementNewPayload: newPayloadFor(new Set(placementAll.map((item) => item.id))),
    knockoutNewPayload: newPayloadFor(new Set(knockoutAll.map((item) => item.id))),
    placementScheduledIds,
    knockoutScheduledIds,
    unplaced,
    blockedReason,
  };
}

/**
 * The scheduled rows a plan would clear without re-setting.
 *
 * Non-empty means applying the plan would strip a match of its court and time, so
 * the writer must refuse rather than let the database guard fail the transaction
 * with no indication of which match was dropped. Rows `void` by the desk, and
 * knockout byes, are not counted because the writer never clears them.
 *
 * Exported and pure so the invariant is testable without a database.
 */
export function uncoveredScheduledMatches(plan: PlacementSchedulePlan): {
  placement: string[];
  knockout: string[];
} {
  const missingFor = (
    scheduledIds: readonly string[],
    payload: readonly PlacementSlotPayload[],
  ): string[] => {
    const covered = new Set(payload.map((slot) => slot.match_id));
    return scheduledIds.filter((id) => !covered.has(id));
  };
  return {
    placement: missingFor(plan.placementScheduledIds, plan.placementSlotPayload),
    knockout: missingFor(plan.knockoutScheduledIds, plan.knockoutSlotPayload),
  };
}

/**
 * Splits what could not be placed into "the desk must intervene" and "this is not
 * a match yet".
 *
 * Mirrors the same distinction in `actions.ts`. A match with no players is a
 * knockout fixture waiting for its bracket, which is normal; a match with players
 * that the scheduler still could not fit is a real problem.
 */
function partitionUnscheduled(
  unscheduled: readonly string[],
  items: readonly StageItem[],
): { blocked: string[]; awaitingTeams: string[] } {
  const blocked: string[] = [];
  const awaitingTeams: string[] = [];
  for (const id of unscheduled) {
    const item = items.find((match) => match.id === id);
    if (!item || item.participantsKnown === false || item.participantIds.length === 0) {
      awaitingTeams.push(id);
    } else {
      blocked.push(id);
    }
  }
  return { blocked, awaitingTeams };
}

/**
 * What is wrong with the matches that could not be placed, in the cause-and-effect
 * order a desk needs to fix them.
 *
 * The old message was the first deadlocking run's: "No future event can make 1
 * remaining match(es) eligible". It named a count that could disagree with the list
 * printed under it, and never said what was wrong. Three causes reach here and they
 * need opposite responses — a prerequisite that is not scheduled at all, a knockout
 * held behind the placement stage, and a set that is waiting on itself — so each is
 * named.
 *
 * The first is a guard rather than a routine path: `placementItems` drops
 * prerequisites that are not in the batch precisely so one abandoned match cannot
 * make a day unschedulable. It is kept because the shape it describes is the one
 * this planner has actually failed in before — a prerequisite placed by an earlier
 * day was invisible to a later day's run — and a message that names it is what turns
 * the next one of those from an hour of guessing into an obvious answer.
 */
function explainBlocked(
  blocked: readonly string[],
  input: {
    items: readonly StageItem[];
    scheduledIds: ReadonlySet<string>;
    /** Knockouts still queued because the placement stage has not drained. */
    heldByPlacement: ReadonlySet<string>;
  },
): string {
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const blockedIds = new Set(blocked);
  const dependsOn = (id: string) => byId.get(id)?.dependencies ?? [];

  const orphaned = blocked.flatMap((id) =>
    dependsOn(id)
      .filter(
        (dependencyId) =>
          // Still waiting its own slot is not a cause: it is placed first. Neither
          // scheduled nor waiting means nothing in this plan will ever place it.
          !input.scheduledIds.has(dependencyId) && !blockedIds.has(dependencyId),
      )
      .map((dependencyId) => ({ id, dependencyId })),
  );
  const held = blocked.filter((id) => input.heldByPlacement.has(id));

  /**
   * Whether the placement stage is stuck with itself.
   *
   * It cannot drain for capacity reasons — the last day is allowed to overrun — so a
   * placement match that no day took is either missing a prerequisite or waiting on
   * one of its own. Knockouts are excluded: they carry no `dependencies` at all, their
   * ordering is the stage barrier, so they would read as "able to start" and mask it.
   */
  const placementStuck = blocked.filter((id) => !input.heldByPlacement.has(id));
  const mutual =
    placementStuck.length > 0 &&
    !placementStuck.some((id) =>
      dependsOn(id).every((dependencyId) => input.scheduledIds.has(dependencyId)),
    );

  const reasons: string[] = [];
  if (orphaned.length) {
    const distinct = [...new Set(orphaned.map((entry) => entry.id))];
    // The prerequisite is named because the list of blocked matches below names only
    // the match, never what it is waiting for.
    reasons.push(
      `${distinct.length} ${distinct.length === 1 ? "is" : "are"} waiting on a prerequisite that this plan never schedules (${orphaned[0]!.dependencyId})`,
    );
  } else if (mutual) {
    reasons.push(
      `${placementStuck.length} placement ${placementStuck.length === 1 ? "match is" : "matches are"} waiting on each other, so none of them can go first`,
    );
  }
  // Named after the cause, never before it: knockouts are only ever held because
  // placement did not drain, so leading with them would point at the symptom.
  if (held.length) {
    reasons.push(
      `${held.length} knockout ${held.length === 1 ? "match is" : "matches are"} held behind the placement stage`,
    );
  }
  if (reasons.length) return `${reasons.join(", and ")}.`;

  return "Each has every prerequisite placed, but no court and a free pair of players come free at the same time.";
}

/**
 * Sorts every match the plan left without a slot into a cause the host can act on.
 *
 * Pure. The order matters: no courts anywhere explains everything and is checked first; an entrant
 * with no team and a broken prerequisite chain are data problems no retry can fix; a knockout held
 * behind placement is named for what it is waiting on rather than for its own symptom; and what is
 * left is a capacity cause, which for automatic placement means the close.
 */
export function classifyUnplaced(input: {
  blocked: readonly string[];
  awaitingTeams: readonly string[];
  items: readonly StageItem[];
  scheduledIds: ReadonlySet<string>;
  placementUnscheduled: ReadonlySet<string>;
  daysWithCourts: number;
  strictClose: boolean;
}): UnplacedMatch[] {
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const blockedIds = new Set(input.blocked);
  const out: UnplacedMatch[] = [];

  const noCourts = input.daysWithCourts === 0;
  for (const matchId of input.awaitingTeams) {
    out.push({ matchId, reason: noCourts ? "no_courts" : "data" });
  }

  // A placement match is stuck for itself when it waits on something that will never be placed.
  const orphaned = (id: string) =>
    (byId.get(id)?.dependencies ?? []).some(
      (dependencyId) => !input.scheduledIds.has(dependencyId) && !blockedIds.has(dependencyId),
    );
  const placementBlocked = input.blocked.filter((id) => input.placementUnscheduled.has(id));
  const mutual =
    placementBlocked.length > 0 &&
    !placementBlocked.some((id) =>
      (byId.get(id)?.dependencies ?? []).every((dependencyId) => input.scheduledIds.has(dependencyId)),
    );

  for (const matchId of input.blocked) {
    let reason: UnplacedReason;
    if (noCourts) reason = "no_courts";
    else if (orphaned(matchId) || (mutual && input.placementUnscheduled.has(matchId))) reason = "data";
    else if (!input.placementUnscheduled.has(matchId) && input.placementUnscheduled.size > 0) {
      reason = "held_behind_placement";
    } else reason = input.strictClose ? "past_closing" : "no_slot";
    out.push({ matchId, reason });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Writes a whole plan. Refuses to persist one that left a schedulable match out: a
 * half-built schedule is worse than none, because a match with players and no court
 * looks like a fixture the desk forgot rather than one it never created.
 *
 * Two calls rather than one, because `apply_placement_day_schedule` is stage-scoped
 * and clears only its own stage's rows. Placement goes first so a failure part-way
 * leaves the earlier stage scheduled rather than the later one orphaned.
 *
 * The completeness check is repeated here against the plan's own `scheduled` rows
 * because the RPC's equivalent guard can only say that *some* row was dropped. When
 * the planner is handed an input it cannot read — an entrant list or team list that
 * has not loaded, say — every match looks like it is still waiting for its players,
 * `blocked` stays empty, and the payload comes out short. Catching it here names the
 * cause and leaves the database untouched, instead of letting the RPC clear the day
 * and then roll the whole thing back with "left assigned matches without a court or
 * time".
 */
export async function applyPlacementSchedulePlan(plan: PlacementSchedulePlan): Promise<void> {
  if (plan.blocked.length > 0) {
    throw new Error(
      plan.blockedReason
        ? `Cannot apply the schedule: ${plan.blocked.length} match(es) could not be placed. ${plan.blockedReason}`
        : `Cannot apply the schedule: ${plan.blocked.length} match(es) could not be placed.`,
    );
  }

  const uncovered = uncoveredScheduledMatches(plan);
  const dropped = [...uncovered.placement, ...uncovered.knockout];
  if (dropped.length > 0) {
    throw new Error(
      `Cannot apply the schedule: ${dropped.length} already-scheduled match(es) have no court or time in this plan. ` +
        `This means the planner could not read their players — reload the page and build again.`,
    );
  }

  const calls: [PlacementStageName, PlacementSlotPayload[]][] = [
    ["placement", plan.placementSlotPayload],
    ["knockout", plan.knockoutSlotPayload],
  ];
  for (const [stage, slots] of calls) {
    const { error } = await supabase.rpc("apply_placement_day_schedule", {
      p_tournament_id: plan.tournamentId,
      p_stage: stage,
      p_slots: slots as never,
    });
    if (error) throw new Error(error.message);
  }
}

/**
 * How many matches are ready to play but hold no court or time.
 *
 * Ready means the same thing everywhere: still `scheduled`, both sides known, not a bye. The
 * Schedule page shows this as "N ready matches have no time", the one thing the automatic pass
 * can leave behind (no room in the day, or the server declined a slot).
 */
export function readyUnplacedCount(
  placementMatches: readonly PlacementMatch[],
  tierMatches: readonly TierDrawMatch[],
): number {
  return readyUnplacedIds(placementMatches, tierMatches).length;
}

/** The ids behind `readyUnplacedCount`, sorted, so a set of them can be compared by value. */
export function readyUnplacedIds(
  placementMatches: readonly PlacementMatch[],
  tierMatches: readonly TierDrawMatch[],
): string[] {
  const unplaced = (match: { court_id: string | null; scheduled_time: string | null }) =>
    match.court_id == null || match.scheduled_time == null;
  const placement = placementMatches.filter(
    (match) =>
      match.status === "scheduled" &&
      match.entrant_a_id != null &&
      match.entrant_b_id != null &&
      unplaced(match),
  );
  const tier = tierMatches.filter(
    (match) =>
      match.status === "scheduled" &&
      isTierMatchReady({
        entrantAId: match.entrant_a_id,
        entrantBId: match.entrant_b_id,
        isBye: match.is_bye,
      }) &&
      unplaced(match),
  );
  return [...placement, ...tier].map((match) => match.id).sort();
}

/** What `place_ready_matches` did with a plan, by match id. */
export interface PlaceReadyResult {
  placed: string[];
  skipped: { match_id: string; reason: string }[];
}

/**
 * Writes a `place-ready` plan through the additive RPC.
 *
 * Unlike `applyPlacementSchedulePlan` this clears nothing, so the coverage guard does not apply:
 * a match the plan does not name keeps whatever time it has. A match the server declines (the court
 * or a player got busy since the plan was read, it was placed by someone else, it is no longer
 * ready) is reported in `skipped` rather than thrown, because a plan computed a moment ago being
 * slightly stale is expected, not an error. Only a transport or authorization failure throws.
 */
export async function applyPlaceReadyPlan(plan: PlacementSchedulePlan): Promise<PlaceReadyResult> {
  const result: PlaceReadyResult = { placed: [], skipped: [] };
  const calls: [PlacementStageName, PlacementSlotPayload[]][] = [
    ["placement", plan.placementNewPayload],
    ["knockout", plan.knockoutNewPayload],
  ];
  for (const [stage, slots] of calls) {
    if (slots.length === 0) continue;
    const { data, error } = await supabase.rpc("place_ready_matches", {
      p_tournament_id: plan.tournamentId,
      p_stage: stage,
      p_slots: slots as never,
    });
    if (error) throw new Error(error.message);
    const body = (data ?? {}) as Partial<PlaceReadyResult>;
    result.placed.push(...(body.placed ?? []));
    result.skipped.push(...(body.skipped ?? []));
  }
  return result;
}

/** The columns the schedule writer owns, shared by the two match tables. */
export interface SchedulableMatchRow {
  id: string;
  status: string;
  scheduled_time: string | null;
  court_id: string | null;
  /** A bye is never scheduled, and the writer's clear skips them. */
  is_bye?: boolean;
}

/**
 * The rows an applied plan leaves in the table, projected onto the rows already in hand.
 *
 * The running order is read from the query cache, so the page has to be able to show the
 * plan it just wrote without waiting for a refetch to notice the write. Waiting is not
 * safe: `invalidateQueries` resolves even when the refetch it triggers fails, so a
 * dropped request leaves the pre-build rows on screen underneath a success toast — the
 * build looks like it did nothing until the page is reloaded.
 *
 * This invents nothing, because the payload is the writer's own instruction:
 *
 *  - `apply_placement_day_schedule` clears `scheduled_time` and `court_id` on every
 *    scheduled row of its stage (byes excepted) and then re-sets exactly the rows the
 *    payload names, so a row the payload omits is one the writer has just emptied.
 *  - It fails the whole transaction if it leaves any scheduled row without a court or a
 *    time, so a payload that named fewer rows than it cleared was never applied.
 *
 * A reported or started match is an anchor — the writer never touches it, so neither does
 * this.
 */
export function projectSlotsOntoMatches<T extends SchedulableMatchRow>(
  matches: readonly T[],
  slots: readonly PlacementSlotPayload[],
): T[] {
  const byMatchId = new Map(slots.map((slot) => [slot.match_id, slot]));
  return matches.map((match) => {
    if (match.status !== "scheduled" || match.is_bye === true) return match;
    const slot = byMatchId.get(match.id);
    return Object.assign({}, match, {
      scheduled_time: slot?.scheduled_time ?? null,
      court_id: slot?.court_id ?? null,
    });
  });
}

/**
 * A human label for a match id, for the rebuild preview.
 *
 * The preview lists matches by id, and a raw uuid tells the desk nothing about
 * which fixture is moving — which is the one thing the preview exists to answer.
 */
export function placementMatchLabel(
  matchId: string,
  placementMatches: readonly PlacementMatch[],
  tierMatches: readonly TierDrawMatch[],
  labelForEntrant: (entrantId: string | null) => string,
): string {
  const placement = placementMatches.find((match) => match.id === matchId);
  if (placement) {
    return `${labelForEntrant(placement.entrant_a_id)} vs ${labelForEntrant(placement.entrant_b_id)}`;
  }
  const tier = tierMatches.find((match) => match.id === matchId);
  if (tier) {
    return `${labelForEntrant(tier.entrant_a_id)} vs ${labelForEntrant(tier.entrant_b_id)}`;
  }
  return matchId.slice(0, 8);
}

/** Exported for the stage selector, so the UI and the planner cannot disagree. */
export function placementStageLabel(stage: PlacementStageName): string {
  return stage === "placement" ? "placement" : "knockouts";
}
