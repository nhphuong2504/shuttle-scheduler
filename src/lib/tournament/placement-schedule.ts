/**
 * Day planning for the two-round placement format.
 *
 * This is the placement format's counterpart to `planDay` in `actions.ts`, and it
 * exists as a separate module for the same reason the tables are separate: the
 * legacy planner reads `pool_matches` and `draw_matches` by name, and teaching it
 * about a second pair of tables would mean a function that has to know which
 * format it is looking at.
 *
 * What is shared is deliberate and narrow: the GRASP scheduler, the greedy
 * scheduler, the plan diff and the summary shape are all imported rather than
 * reimplemented. Only the row-to-match conversion and the persistence call are
 * format-specific, which is where the two formats genuinely differ.
 *
 * Two conversions are worth calling out:
 *
 *   * A placement match carries two *entrant* ids, and an entrant points at a
 *     team. Player ids therefore need an extra hop that the legacy tables do not.
 *     Getting this wrong would not fail loudly; the scheduler would just see a
 *     match with no players and mark it awaiting teams.
 *   * `placement_matches.prerequisite_ids` is the held entrant's ordering rule
 *     ("my second make-up waits for my first"). It maps straight onto the
 *     scheduler's `dependsOn`, which is what makes the held entrant's two matches
 *     sequential rather than simultaneous.
 */

import { supabase } from "@/integrations/supabase/client";

import type { ScheduleSummary, DayOneSchedulerOptions } from "./actions";
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
import {
  diffPlan,
  projectedFinishFromRemainingMatches,
  type SchedulePlanDiff,
} from "./schedule-diff";
import {
  scheduleMatches,
  type BreakWindow,
  type SchedulableMatch,
  type ScheduledSlot,
} from "./scheduler";
import {
  scheduleGroupStageGrasp,
  type GraspDiagnostics,
  type GraspSchedulableMatch,
} from "./scheduler-grasp";

const MINUTE = 60_000;

/**
 * One day's share of a whole-schedule plan.
 *
 * Days are capacity, not build units: a day can hold the tail of one stage and the
 * head of the next, which is why this reports what landed on it rather than which
 * stage it was "for".
 */
export interface PlacementDayFill {
  day: number;
  date: string;
  /** Matches newly placed on this day. Anchors are reported separately. */
  placed: number;
  /** Slots the day could hold if every court ran back to back across its window. */
  capacity: number;
  /** Latest finish on this day, or null when nothing is on it. */
  lastFinish: string | null;
  overrunMinutes: number;
}

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
  fixedMatchIds: string[];
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
  /** Why the scheduler could not place something, for the desk-facing error. */
  blockedReason: string | null;
}

// ---------------------------------------------------------------------------
// Row-to-match conversion
// ---------------------------------------------------------------------------

/**
 * Resolves entrant ids to player ids through the entrant's team.
 *
 * Entrants that are still unknown (a knockout match whose parents have not been
 * decided) are reported as not known, not as an error: that match simply is not
 * schedulable yet.
 */
function buildPlayerLookup(
  entrants: readonly PlacementEntrant[],
  teams: readonly Team[],
): (entrantIds: readonly (string | null)[]) => {
  playerIds: string[];
  playersKnown: boolean;
} {
  const teamIdByEntrant = new Map(entrants.map((entrant) => [entrant.id, entrant.team_id]));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  return (entrantIds) => {
    const playerIds: string[] = [];
    let playersKnown = true;
    for (const entrantId of entrantIds) {
      const teamId = entrantId ? teamIdByEntrant.get(entrantId) : undefined;
      const team = teamId ? teamById.get(teamId) : undefined;
      if (!team) {
        // A missing side is "not yet decided" for a knockout, and a data problem
        // for a placement match. Both are handled the same way: the match is not
        // schedulable, and it surfaces as awaiting teams rather than as a silent
        // match with one player.
        playersKnown = false;
        continue;
      }
      playerIds.push(team.player_1_id);
      if (team.player_2_id) playerIds.push(team.player_2_id);
    }
    return { playerIds, playersKnown };
  };
}

function combineDateTime(date: string, time: string): Date {
  const normalized = time.length === 5 ? `${time}:00` : time;
  return new Date(`${date}T${normalized}`);
}

/**
 * The courts a day actually plays on.
 *
 * A tournament created before per-day court sets existed has no rows here, and
 * the only sensible reading of that is "every court, every day" — so an empty
 * set falls back rather than leaving a day with nothing to schedule on.
 */
export function courtsForDay(
  allCourts: readonly Court[],
  dayCourtIds: ReadonlySet<string>,
): Court[] {
  if (!dayCourtIds.size) return [...allCourts];
  return allCourts.filter((court) => dayCourtIds.has(court.id));
}

/**
 * A day's window as absolute milliseconds, both ends together.
 *
 * Parsing lives here rather than at each call site because a bare `YYYY-MM-DD` is
 * read as UTC midnight, which is a day earlier everywhere west of Greenwich —
 * `dayDateLabel` in `format.ts` exists for the same reason. Returning the pair as
 * one value also makes it impossible to pair a start from one day with an end from
 * another.
 */
export function dayWindowBounds(day: TournamentDay): { start: number; end: number } {
  return {
    start: combineDateTime(day.date, day.start_time).getTime(),
    end: combineDateTime(day.date, day.end_time).getTime(),
  };
}

/** A day's configured breaks as absolute windows, so the schedulers can step over them. */
export function breakWindowsFor(
  day: TournamentDay,
  breaks: readonly TournamentDayBreak[] | undefined,
): BreakWindow[] {
  return (breaks ?? []).map((brk) => ({
    start: combineDateTime(day.date, brk.start_time).getTime(),
    end: combineDateTime(day.date, brk.end_time).getTime(),
  }));
}

/**
 * One day's slice of a running order, with the day it came from.
 *
 * `day` is the tournament day rather than a date, so a caller can label the slice
 * with the day number the rest of the app uses.
 */
export interface DaySlice<T> {
  day: TournamentDay;
  rows: T[];
}

/**
 * Splits rows into one slice per tournament day, in day order.
 *
 * A row belongs to the last day that had already started when it did, which is the
 * same rule the planner works to: matches are placed inside a day's window, and the
 * last day is allowed to overrun its closing time, so a row can legitimately start
 * after its own day's `end_time` — including after midnight, on the next calendar
 * date. Bucketing by calendar date would file such a row under the following day, or
 * under no day at all; bucketing by "which day had opened" cannot.
 *
 * Every day comes back, including one with no rows: a two-day tournament should show
 * two days even before the second has anything on it, which is the whole point of
 * the view. Rows are returned in the order they were given, so a caller that hands
 * them over sorted by time gets each slice sorted by time.
 *
 * A row that starts before the first day opened is attributed to the first day. In
 * practice that is a match reported early, and showing it on the day it belongs to
 * beats hiding it.
 */
export function sliceRowsByDay<T>(
  rows: readonly T[],
  days: readonly TournamentDay[],
  startOf: (row: T) => Date,
): DaySlice<T>[] {
  const ordered = [...days].sort((a, b) => a.day_number - b.day_number);
  const slices: DaySlice<T>[] = ordered.map((day) => ({ day, rows: [] }));
  if (!slices.length) return slices;

  const starts = ordered.map((day) => dayWindowBounds(day).start);

  for (const row of rows) {
    const at = startOf(row).getTime();
    // `starts` is ascending, so the last one at or before the row is the day it fell
    // in. NaN — an unparseable time — fails every comparison and lands on the first
    // day, which is the same place a row from before opening goes.
    let index = 0;
    for (let candidate = 0; candidate < starts.length; candidate += 1) {
      if (starts[candidate]! <= at) index = candidate;
    }
    slices[index]!.rows.push(row);
  }

  return slices;
}

/** A match has a real result, so its time is an anchor rather than a suggestion. */
function isFixed(status: string): boolean {
  return status === "reported" || status === "in-progress" || status === "walkover";
}

function anchorStart(scheduledTime: string | null, startedAt: string | null): number | undefined {
  const anchor = startedAt ?? scheduledTime;
  return anchor ? new Date(anchor).getTime() : undefined;
}

/**
 * The range a fixed match occupies, returned as a pair so the two can never
 * disagree about the direction of time.
 *
 * Taking a reported match's `ended_at` literally is not enough, because it is not
 * always after its `scheduled_time`: the desk can report a walkover, or a round
 * played ahead of schedule, and then the finish precedes the planned start. A match
 * that ends before it begins is refused by the scheduler, and it refuses the whole
 * batch rather than the one row, so the planned slot wins in that case. That also
 * stops the slot being handed to another match while this row still claims it.
 *
 * The same reasoning covers a match reported before it was ever given a slot: it
 * has no start of its own, and one slot is inferred from the finish, because it
 * cannot have been played without occupying a court for a slot's worth of time.
 */
function fixedRange(input: {
  status: string;
  scheduledTime: string | null;
  startedAt: string | null;
  endedAt: string | null;
  slotMinutes: number;
  floor: number;
  now: number;
}): { start: number; end: number } | undefined {
  const slotMs = input.slotMinutes * MINUTE;
  const anchored = anchorStart(input.scheduledTime, input.startedAt);
  const finished = input.endedAt ? new Date(input.endedAt).getTime() : undefined;

  if (input.status === "reported" || input.status === "walkover") {
    const end = finished ?? (anchored != null ? anchored + slotMs : undefined);
    if (end == null) return undefined;
    const start = anchored ?? end - slotMs;
    return { start, end: Math.max(end, start + slotMs) };
  }

  // Anything else is in progress. Its real end is unknown, so it is modelled as at
  // least one slot from now: leaving it at its planned end would let the next match
  // start on that court before the running one has finished.
  const start = anchored ?? finished;
  if (start == null) return undefined;
  return {
    start,
    end: Math.max(start + slotMs, input.floor + slotMs, input.now + slotMs),
  };
}

/**
 * Placement matches, in the shape the GRASP scheduler wants.
 *
 * `dependsOn` is filled from `prerequisite_ids`, but only for prerequisites that
 * are themselves in this batch. A prerequisite that is void or missing would
 * otherwise be a dependency the scheduler can never satisfy, which turns one
 * abandoned match into an unschedulable day — so it is dropped and the match is
 * left to the desk.
 */
function placementItems(input: {
  matches: readonly PlacementMatch[];
  playerLookup: (entrantIds: readonly (string | null)[]) => {
    playerIds: string[];
    playersKnown: boolean;
  };
  courtNumberById: ReadonlyMap<string, number>;
  categoryOrder: ReadonlyMap<string, number>;
  slotMinutes: number;
  floor: number;
  now: number;
}): GraspSchedulableMatch[] {
  const { matches, playerLookup, courtNumberById, categoryOrder, slotMinutes, floor, now } = input;
  // Non-void rows are the schedulable universe, and the set a prerequisite must
  // be a member of to be honoured.
  const inBatch = new Set(
    matches.filter((match) => match.status !== "void").map((match) => match.id),
  );

  return matches
    .filter((match) => match.status !== "void")
    .map((match) => {
      const { playerIds, playersKnown } = playerLookup([match.entrant_a_id, match.entrant_b_id]);
      const fixed = isFixed(match.status);
      const range = fixed
        ? fixedRange({
            status: match.status,
            scheduledTime: match.scheduled_time,
            startedAt: match.started_at,
            endedAt: match.ended_at,
            slotMinutes,
            floor,
            now,
          })
        : undefined;
      return {
        id: match.id,
        categoryId: match.category_id,
        categoryOrder: categoryOrder.get(match.category_id) ?? 0,
        // No pool to complete: a placement category is its own completion unit,
        // so the scheduler's completion-pressure term falls back to the category.
        poolId: null,
        playerIds,
        playersKnown,
        kind: "group" as const,
        // Round one ranks before round two, but only as a late tie-break: GRASP
        // prioritises the most constrained player first. That is sufficient here
        // because round two is only generated once every round-one result is in,
        // so a round-one match is always a fixed anchor by the time a round-two
        // match is movable — and a fixed anchor constrains its players directly.
        // The two rounds cannot compete for the same court slot.
        order: match.stage === "round1" ? 1 : 2,
        round: match.stage === "round1" ? 1 : 2,
        dependsOn: match.prerequisite_ids.filter((id) => inBatch.has(id)),
        fixed,
        start: range?.start,
        end: range?.end,
        courtNumber: match.court_id ? courtNumberById.get(match.court_id) : undefined,
      };
    });
}

/**
 * Tier-draw matches, in the shape the greedy scheduler wants.
 *
 * A match with an undecided side is dropped rather than listed as awaiting teams:
 * it is not a match yet, and including it would make every not-yet-reached round
 * show as a missing fixture. Byes are dropped for the same reason plus one more —
 * they are already decided and there is nothing to place.
 */
function tierItems(input: {
  matches: readonly TierDrawMatch[];
  drawCategory: ReadonlyMap<string, string>;
  playerLookup: (entrantIds: readonly (string | null)[]) => {
    playerIds: string[];
    playersKnown: boolean;
  };
  courtNumberById: ReadonlyMap<string, number>;
  categoryOrder: ReadonlyMap<string, number>;
  slotMinutes: number;
  restGap: number;
  floor: number;
  now: number;
}): SchedulableMatch[] {
  const { matches, drawCategory, playerLookup, courtNumberById, categoryOrder } = input;
  const { slotMinutes, restGap, floor, now } = input;

  // Indexed once: the parent lookup below would otherwise rescan `matches` for
  // every match, which is quadratic in a bracket that is already large.
  const byId = new Map(matches.map((match) => [match.id, match]));

  return matches
    .filter((match) => !match.is_bye && match.status !== "void")
    .map((match) => {
      const { playerIds, playersKnown } = playerLookup([match.entrant_a_id, match.entrant_b_id]);
      // A knockout match may not start until both of its feeders have finished,
      // plus the player rest gap — including when a feeder was decided by a bye
      // rather than played.
      const parentEnd = [match.parent_a_id, match.parent_b_id].reduce((acc, parentId) => {
        const parent = parentId ? byId.get(parentId) : undefined;
        const finished = parent?.ended_at ?? parent?.reported_time;
        return finished ? Math.max(acc, new Date(finished).getTime() + restGap * MINUTE) : acc;
      }, 0);
      const fixed = isFixed(match.status);
      const range = fixed
        ? fixedRange({
            status: match.status,
            scheduledTime: match.scheduled_time,
            startedAt: match.started_at,
            endedAt: match.ended_at,
            slotMinutes,
            floor,
            now,
          })
        : undefined;
      const categoryId = drawCategory.get(match.draw_id) ?? match.draw_id;

      return {
        id: match.id,
        categoryId,
        categoryOrder: categoryOrder.get(categoryId) ?? 0,
        poolId: null,
        playerIds,
        playersKnown,
        kind: "knockout" as const,
        order: match.round * 100 + match.slot,
        earliestStart: parentEnd || undefined,
        fixed,
        start: range?.start,
        end: range?.end,
        courtNumber: match.court_id ? courtNumberById.get(match.court_id) : undefined,
      };
    })
    .filter((item) => {
      // An already-reported match stays in the batch as an anchor. Anything else
      // needs two sides that have actually been decided: a knockout fixture waiting
      // on its bracket is not a match yet, and listing it would make every
      // not-yet-reached round look like something the desk has to chase.
      if (!item.fixed) return item.playerIds.length > 0;
      // A decided match needs no slot, so it is only ever an anchor — and an anchor
      // needs a court and a window to hold. A reported row missing either (a walkover
      // never laid out on a court, or one played on a court that has since been
      // deleted) cannot be modelled as one, and handing it to the scheduler makes it
      // refuse the whole batch over a row that is already history. It is left out.
      return item.start != null && item.end != null && item.courtNumber != null;
    });
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

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
}

/** A local `YYYY-MM-DD` key, so a fixed match can be attributed to exactly one day. */
function localDateKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

interface StageRun {
  slots: ScheduledSlot[];
  unscheduled: string[];
  utilization: number;
  overrun: boolean;
  overrunMinutes: number;
  deadlockReason: string | null;
  diagnostics: GraspDiagnostics | null;
}

/**
 * Runs one stage across one day.
 *
 * Each stage keeps its own duration and rest gap, which is why a day is filled in
 * two passes rather than one: a placement match holds a court for 20 minutes and a
 * knockout match for 45, and a single call cannot express both.
 *
 * `hardEnd` is what lets the queue spill. Without it a day absorbs everything it is
 * given and simply runs late, so the following days would never be reached and the
 * last day's overrun forecast would be the only thing that ever fired.
 */
function runStageForDay(input: {
  stage: PlacementStageName;
  dayStart: Date;
  planningEnd: Date;
  hardEnd: Date | undefined;
  schedulingFloor: Date;
  courts: Court[];
  breaks: readonly BreakWindow[];
  items: GraspSchedulableMatch[];
  slotMinutes: number;
  restGapMinutes: number;
  options?: DayOneSchedulerOptions | undefined;
}): StageRun {
  const { stage, dayStart, planningEnd, hardEnd, schedulingFloor, courts, breaks, items } = input;
  const { slotMinutes, restGapMinutes, options } = input;

  if (stage === "placement") {
    const result = scheduleGroupStageGrasp(items, {
      dayStart,
      planningEnd,
      hardEnd,
      schedulingFloor,
      courts,
      slotMinutes,
      restGapMinutes,
      breaks,
      ...options,
    });
    return {
      slots: result.slots,
      unscheduled: result.unscheduled,
      utilization: result.utilization,
      overrun: result.overrun,
      overrunMinutes: result.overrunMinutes,
      deadlockReason: result.diagnostics.deadlockReason,
      diagnostics: result.diagnostics,
    };
  }

  const result = scheduleMatches(items as SchedulableMatch[], {
    dayStart,
    planningEnd,
    hardEnd,
    // Same floor as the placement pass: a rebuild must not hand a knockout a start
    // time that has already gone by, which the desk reads as "ready now".
    floor: schedulingFloor,
    courts,
    slotMinutes,
    restGapMinutes,
    breaks,
  });
  return {
    slots: result.slots,
    unscheduled: result.unscheduled,
    utilization: result.utilization,
    overrun: result.overrun,
    overrunMinutes: result.overrunMinutes,
    deadlockReason: null,
    diagnostics: null,
  };
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
 * is in and a knockout round cannot exist until the previous one is decided. That
 * is why this needs no round-ordering logic of its own: scheduling everything that
 * exists is the same thing as scheduling in order.
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
    options: graspOptions,
    now = Date.now(),
  } = input;

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

  // Only used to model an in-progress match's end, because each day applies its own
  // floor at run time. The earliest plausible start keeps that model conservative.
  const firstDayStart = combineDateTime(orderedDays[0]!.date, orderedDays[0]!.start_time).getTime();
  const itemFloor = isRebuild ? Math.max(firstDayStart, nextWholeMinute) : firstDayStart;

  // Round one and round two are one stage, so they share a duration and a queue
  // slot; the queue has two printers, not three.
  const placementAll = placementItems({
    matches: placementMatches,
    playerLookup,
    courtNumberById,
    categoryOrder,
    slotMinutes: placementSlot,
    floor: itemFloor,
    now,
  });
  const knockoutAll = tierItems({
    matches: tierMatches,
    drawCategory,
    playerLookup,
    courtNumberById,
    categoryOrder,
    slotMinutes: knockoutSlot,
    restGap: knockoutRest,
    floor: itemFloor,
    now,
  }) as GraspSchedulableMatch[];

  const everything = [...placementAll, ...knockoutAll];
  const fixedSet = new Set(everything.filter((item) => item.fixed).map((item) => item.id));
  const knockoutIds = new Set(knockoutAll.map((item) => item.id));

  // The queue itself: what is still waiting for a slot. A match leaves its set only
  // when it has been given one, so anything that will not fit today is retried
  // tomorrow rather than silently dropped.
  const placementTodo = new Set(placementAll.filter((item) => !item.fixed).map((item) => item.id));
  const knockoutTodo = new Set(knockoutAll.filter((item) => !item.fixed).map((item) => item.id));

  const allSlots: ScheduledSlot[] = [];
  const dayFills: PlacementDayFill[] = [];
  let totalCapacityMinutes = 0;
  let usedMinutes = 0;
  let lastFinishMs: number | null = null;
  let lastPlanningEndMs = 0;
  let lastDiagnostics: GraspDiagnostics | null = null;

  /** This day's anchors, so a fixed match is counted on exactly one day. */
  const anchorsOn = (items: readonly GraspSchedulableMatch[], dayKey: string) =>
    items.filter((item) => item.fixed && item.start != null && localDateKey(item.start) === dayKey);

  const daysWithCourts = orderedDays.filter(
    (day) => courtsForDay(allCourts, dayCourtIds?.get(day.id) ?? new Set()).length > 0,
  );
  const lastFilledDayId = daysWithCourts[daysWithCourts.length - 1]?.id ?? null;

  /**
   * Slots placed by an earlier day, handed to the days after it as anchors.
   *
   * A run builds `scheduledEnd` from its own fixed items only, and `isEligible`
   * treats a dependency that is missing from that map as unsatisfiable forever:
   * `scheduledEnd.get(id) == null` fails the check rather than deferring it. So a
   * match placed on Monday is invisible to Tuesday's run, and anything depending on
   * it can never be placed — it deadlocks with a message that blames the day's
   * window, and because one stuck placement match also stops the knockout pass, a
   * single unresolved prerequisite can refuse the whole build.
   *
   * That is not hypothetical: the two make-up matches of the placement format
   * depend on other round-two matches, so any tournament whose round two spans a
   * day boundary hits it. Carrying the earlier days' slots forward is what makes a
   * dependency across midnight resolvable.
   *
   * These are anchors, not results: they are already in `allSlots` and in the
   * payload, so they are filtered back out of every slot list below rather than
   * recorded twice.
   *
   * The court is deliberately dropped. An earlier day's slot has no bearing on a
   * later day's courts — the days do not overlap in time — and a day is entitled to
   * play on a different set of courts, so naming one the later day does not have
   * would fail the run's own court validation and refuse a build that is perfectly
   * schedulable. The player window is kept, because the rest gap does cross
   * midnight, and the end time is the whole point of the exercise.
   */
  const carriedAnchors: GraspSchedulableMatch[] = [];
  const carriedIds = new Set<string>();
  const carrySlot = (slot: ScheduledSlot): GraspSchedulableMatch => {
    const item = everything.find((entry) => entry.id === slot.matchId);
    return {
      id: slot.matchId,
      categoryId: slot.categoryId,
      categoryOrder: item?.categoryOrder,
      playerIds: item?.playerIds ?? [],
      kind: item?.kind ?? "group",
      order: item?.order ?? 0,
      fixed: true,
      start: slot.start.getTime(),
      end: slot.end.getTime(),
    };
  };

  for (const day of orderedDays) {
    const dayStart = combineDateTime(day.date, day.start_time);
    const planningEnd = combineDateTime(day.date, day.end_time);
    const dayKey = localDateKey(dayStart.getTime());
    lastPlanningEndMs = Math.max(lastPlanningEndMs, planningEnd.getTime());

    const courts = courtsForDay(allCourts, dayCourtIds?.get(day.id) ?? new Set());
    const capacityMinutes = courts.length
      ? ((planningEnd.getTime() - dayStart.getTime()) / MINUTE) * courts.length
      : 0;
    totalCapacityMinutes += capacityMinutes;

    if (!courts.length) {
      dayFills.push({
        day: day.day_number,
        date: day.date,
        placed: 0,
        capacity: 0,
        lastFinish: null,
        overrunMinutes: 0,
      });
      continue;
    }

    const breaks = breakWindowsFor(day, breaksByDayId?.get(day.id));
    // Every day but the last one that has courts is a wall. The last day is left to
    // overrun, which is where a tournament's overrun forecast belongs: there is
    // nowhere after it to defer to.
    const hardEnd = day.id === lastFilledDayId ? undefined : planningEnd;
    // A rebuild starts from now, never from the day's opening time: replanning a day
    // already under way must not put matches in the past.
    const schedulingFloor = isRebuild
      ? new Date(Math.max(dayStart.getTime(), nextWholeMinute))
      : dayStart;

    const daySlots: ScheduledSlot[] = [];
    let dayPlaced = 0;

    /**
     * Every placement slot this day holds, however it got there: the reported matches
     * that were played on it, plus whatever pass A places on top.
     *
     * Built from the reported matches rather than from pass A's output because pass A
     * is skipped entirely when nothing movable is left, and the knockout pass still
     * has to know which courts and players this day has already used. A match that
     * overran its slot, or one still on court, holds its court for longer than the
     * clock suggests, so its window has to be handed over even though it is in the
     * past.
     */
    const placementShape = new Map<string, SchedulableMatch>();
    const placementAnchor = (item: {
      id: string;
      categoryId: string;
      playerIds: string[];
      start?: number | undefined;
      end?: number | undefined;
      courtNumber?: number | undefined;
    }): SchedulableMatch | null =>
      item.start == null || item.end == null
        ? null
        : {
            id: item.id,
            categoryId: item.categoryId,
            playerIds: item.playerIds,
            kind: "group",
            order: 0,
            fixed: true,
            start: item.start,
            end: item.end,
            courtNumber: item.courtNumber,
          };
    for (const item of anchorsOn(placementAll, dayKey)) {
      const anchor = placementAnchor(item);
      if (anchor) placementShape.set(item.id, anchor);
    }

    // Pass A — the placement stage.
    if (placementTodo.size) {
      const items = [
        ...anchorsOn(placementAll, dayKey),
        ...carriedAnchors,
        ...placementAll.filter((item) => placementTodo.has(item.id)),
      ];
      const run = runStageForDay({
        stage: "placement",
        dayStart,
        planningEnd,
        hardEnd,
        schedulingFloor,
        courts,
        breaks,
        items,
        slotMinutes: placementSlot,
        restGapMinutes: placementRest,
        options: graspOptions,
      });
      for (const slot of run.slots) {
        if (!placementTodo.has(slot.matchId)) continue;
        placementTodo.delete(slot.matchId);
        dayPlaced++;
      }
      // An earlier day's slots come back out of the run as echoes of their own
      // anchors. They are already recorded, so only this day's work joins the day.
      daySlots.push(...run.slots.filter((slot) => !carriedIds.has(slot.matchId)));
      if (run.diagnostics) lastDiagnostics = run.diagnostics;
    }
    for (const slot of daySlots) {
      if (placementShape.has(slot.matchId)) continue;
      const anchor = placementAnchor({
        id: slot.matchId,
        categoryId: slot.categoryId,
        playerIds: everything.find((item) => item.id === slot.matchId)?.playerIds ?? [],
        start: slot.start.getTime(),
        end: slot.end.getTime(),
        courtNumber: slot.courtNumber,
      });
      if (anchor) placementShape.set(slot.matchId, anchor);
    }

    // Pass B — the knockouts. This is the barrier: they are only attempted once the
    // placement queue has drained, and every one of this day's placement slots is an
    // anchor, so the two stages cannot be double-booked onto one court or one player.
    if (!placementTodo.size && knockoutTodo.size) {
      const anchors = [...placementShape.values()];
      const items = [
        ...anchorsOn(knockoutAll, dayKey),
        ...anchors,
        ...carriedAnchors,
        ...knockoutAll.filter((item) => knockoutTodo.has(item.id)),
      ] as GraspSchedulableMatch[];
      const run = runStageForDay({
        stage: "knockout",
        dayStart,
        planningEnd,
        hardEnd,
        schedulingFloor,
        courts,
        breaks,
        items,
        slotMinutes: knockoutSlot,
        restGapMinutes: knockoutRest,
      });
      for (const slot of run.slots) {
        if (!knockoutTodo.has(slot.matchId)) continue;
        knockoutTodo.delete(slot.matchId);
        dayPlaced++;
      }
      // Only this stage's own slots join the plan. The placement anchors handed in
      // above are echoes of slots pass A has already recorded, and echoing them into
      // the plan as well would list one match twice in the rebuild preview and write
      // it twice, so a rebuild would appear to move a match it never touched. An
      // earlier day's slots are filtered out for the same reason.
      daySlots.push(
        ...run.slots.filter(
          (slot) => knockoutIds.has(slot.matchId) && !carriedIds.has(slot.matchId),
        ),
      );
    }

    allSlots.push(...daySlots);

    // Hand this day's placements to the days after it, so their dependencies on it
    // are knowable. See `carriedAnchors`.
    for (const slot of daySlots) {
      carriedIds.add(slot.matchId);
      carriedAnchors.push(carrySlot(slot));
    }

    let dayLastFinish: number | null = null;
    for (const slot of daySlots) {
      usedMinutes += (slot.end.getTime() - slot.start.getTime()) / MINUTE;
      const end = slot.end.getTime();
      dayLastFinish = dayLastFinish == null ? end : Math.max(dayLastFinish, end);
      lastFinishMs = lastFinishMs == null ? end : Math.max(lastFinishMs, end);
    }

    dayFills.push({
      day: day.day_number,
      date: day.date,
      placed: dayPlaced,
      capacity: capacityMinutes,
      lastFinish: dayLastFinish != null ? new Date(dayLastFinish).toISOString() : null,
      overrunMinutes:
        dayLastFinish != null
          ? Math.max(0, Math.round((dayLastFinish - planningEnd.getTime()) / MINUTE))
          : 0,
    });
  }

  const { blocked, awaitingTeams } = partitionUnscheduled(
    [...placementTodo, ...knockoutTodo],
    everything,
  );

  // Described from the final set rather than from whichever run stopped first. The
  // old wording was that run's: "No future event can make 1 remaining match(es)
  // eligible", which named a count that could disagree with the list printed under
  // it and never said what was actually wrong.
  const blockedReason = blocked.length
    ? explainBlocked(blocked, {
        items: everything,
        scheduledIds: new Set(allSlots.map((slot) => slot.matchId)),
        heldByPlacement: placementTodo.size > 0 ? new Set(knockoutTodo) : new Set(),
      })
    : null;

  const diff = diffPlan(existing, allSlots, fixedSet, courtNumberById);
  diff.unplaceable = blocked;

  // What the current schedule already implies, so the desk can be told whether a
  // rebuild moves the end of the tournament. Each stage is measured with its own
  // duration, which a single call cannot do.
  const currentFinishMs = isRebuild
    ? [
        projectedFinishFromRemainingMatches(placementMatches, placementSlot, now),
        projectedFinishFromRemainingMatches(tierMatches, knockoutSlot, now),
      ].reduce<number | null>(
        (acc, value) => (value == null ? acc : acc == null ? value : Math.max(acc, value)),
        null,
      )
    : null;
  const projectedFinishDeltaMinutes =
    currentFinishMs != null && lastFinishMs != null
      ? Math.round((lastFinishMs - currentFinishMs) / MINUTE)
      : null;

  const summary: ScheduleSummary = {
    placed: diff.placedCount,
    anchorCount: fixedSet.size,
    movedCount: diff.movedCount,
    unscheduled: blocked.length,
    awaitingTeams: awaitingTeams.length,
    utilization: totalCapacityMinutes > 0 ? usedMinutes / totalCapacityMinutes : 0,
    remainingUtilization: lastDiagnostics?.remainingWindowUtilization ?? null,
    overrun: dayFills.some((fill) => fill.overrunMinutes > 0) || blocked.length > 0,
    projectedFinish: lastFinishMs != null ? new Date(lastFinishMs).toISOString() : null,
    currentProjectedFinish:
      currentFinishMs != null ? new Date(currentFinishMs).toISOString() : null,
    projectedFinishDeltaMinutes,
    overrunMinutes:
      lastFinishMs != null && lastPlanningEndMs > 0
        ? Math.max(0, Math.round((lastFinishMs - lastPlanningEndMs) / MINUTE))
        : 0,
    ...(lastDiagnostics ? { diagnostics: lastDiagnostics } : {}),
  };

  const payloadFor = (stageIds: ReadonlySet<string>): PlacementSlotPayload[] =>
    allSlots
      .filter((slot) => stageIds.has(slot.matchId) && !fixedSet.has(slot.matchId))
      .map((slot) => ({
        match_id: slot.matchId,
        scheduled_time: slot.start.toISOString(),
        court_id: slot.courtId,
      }));

  return {
    tournamentId: tournament.id,
    slots: allSlots,
    fixedMatchIds: [...fixedSet],
    blocked,
    awaitingTeams,
    diff,
    summary,
    days: dayFills,
    placementSlotPayload: payloadFor(new Set(placementAll.map((item) => item.id))),
    knockoutSlotPayload: payloadFor(new Set(knockoutAll.map((item) => item.id))),
    blockedReason,
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
  items: readonly GraspSchedulableMatch[],
): { blocked: string[]; awaitingTeams: string[] } {
  const blocked: string[] = [];
  const awaitingTeams: string[] = [];
  for (const id of unscheduled) {
    const item = items.find((match) => match.id === id);
    if (!item || item.playersKnown === false || item.playerIds.length === 0) {
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
    items: readonly GraspSchedulableMatch[];
    scheduledIds: ReadonlySet<string>;
    /** Knockouts still queued because the placement stage has not drained. */
    heldByPlacement: ReadonlySet<string>;
  },
): string {
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const blockedIds = new Set(blocked);
  const dependsOn = (id: string) => byId.get(id)?.dependsOn ?? [];

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
   * one of its own. Knockouts are excluded: they carry no `dependsOn` at all, their
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
 */
export async function applyPlacementSchedulePlan(plan: PlacementSchedulePlan): Promise<void> {
  if (plan.blocked.length > 0) {
    throw new Error(
      plan.blockedReason
        ? `Cannot apply the schedule: ${plan.blocked.length} match(es) could not be placed. ${plan.blockedReason}`
        : `Cannot apply the schedule: ${plan.blocked.length} match(es) could not be placed.`,
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
