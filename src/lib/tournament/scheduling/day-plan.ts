/**
 * The day runner: one tournament queue, filled day by day.
 *
 * This is the piece the planner and the finish estimator share. It owns the day loop — which day
 * has courts, what its wall is, how an earlier day's slots are carried forward as anchors — and it
 * delegates every scheduling decision to the generic solver through `composeDayPlan`. Nothing here
 * decides *whether* a match may be placed; it only decides which day is asked.
 *
 * Extracted from `planPlacementSchedule` so the estimator can run the identical constraints over a
 * larger item set (existing matches plus inevitable-not-yet-created ones) without duplicating the
 * cross-day carry logic. Production passes real items only, so its behavior is unchanged.
 */

import type { SolverDiagnostics, TimeWindow } from "@/lib/scheduling";

import type { Court, TournamentDay, TournamentDayBreak } from "../data";
import { composeDayPlan } from "./composition";
import type { DayOneSchedulerOptions } from "./policy";
import type { StageItem } from "./stage-items";
import type { ScheduledSlot } from "./types";

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
 * The per-day writes a growing venue pool needs, so a court added to the venue joins
 * **every** day rather than only the days nobody had narrowed.
 *
 * A day with no rows already means "every court", so it picks a new court up for free and
 * needs no write. A day narrowed to an explicit subset does not: left alone, it silently
 * keeps playing on the old courts and the new court exists only for the days that were
 * never touched. That asymmetry is what made adding a court look broken from a day card.
 *
 * Only the narrowed days are returned, and each is normalised back to the empty list when
 * the result covers the whole pool, so the "every court" shorthand is restored rather than
 * left implied by an exhaustive list that a later court addition would then contradict.
 */
export function courtsAddedToDays(
  dayIds: readonly string[],
  dayCourtIds: ReadonlyMap<string, ReadonlySet<string>>,
  addedCourtIds: readonly string[],
  poolSize: number,
): { dayId: string; courtIds: string[] }[] {
  if (!addedCourtIds.length) return [];
  const writes: { dayId: string; courtIds: string[] }[] = [];
  for (const dayId of dayIds) {
    const current = dayCourtIds.get(dayId);
    if (!current || !current.size) continue;
    const next = new Set(current);
    for (const courtId of addedCourtIds) next.add(courtId);
    writes.push({ dayId, courtIds: next.size >= poolSize ? [] : [...next] });
  }
  return writes;
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
): TimeWindow[] {
  return (breaks ?? []).map((brk) => ({
    start: combineDateTime(day.date, brk.start_time).getTime(),
    end: combineDateTime(day.date, brk.end_time).getTime(),
  }));
}

/** A local `YYYY-MM-DD` key, so a fixed match can be attributed to exactly one day. */
export function localDateKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
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
 *
 * Days are walked in chronological order, not by `day_number`. The scan below relies
 * on the start times ascending — it takes the *last* one at or before the row — and
 * that only holds if the two orders agree. `tournament_days_guard_order` makes them
 * agree for every writer, and reading the order off the windows rather than trusting
 * the numbers means a row is still filed under the day it actually falls in if a
 * legacy tournament has them out of step. `day_number` is only the tie-break, so the
 * slices stay in the order the rest of the app labels them.
 */
export function sliceRowsByDay<T>(
  rows: readonly T[],
  days: readonly TournamentDay[],
  startOf: (row: T) => Date,
): DaySlice<T>[] {
  const ordered = [...days].sort((a, b) => {
    const startA = dayWindowBounds(a).start;
    const startB = dayWindowBounds(b).start;
    if (startA !== startB) return startA - startB;
    return a.day_number - b.day_number;
  });
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

interface StageRun {
  slots: ScheduledSlot[];
  unscheduled: string[];
  utilization: number;
  overrun: boolean;
  overrunMinutes: number;
  deadlockReason: string | null;
  diagnostics: SolverDiagnostics | null;
}

/**
 * Turns a day's items into a well-formed problem.
 *
 * A fixed item is pinned to its court when the day is playing on it, and becomes a participant
 * anchor otherwise. Either way the item keeps its own duration and window: each item carries the
 * timing of the stage it belongs to, so a placement anchor handed to the knockout pass is still 30
 * minutes long and does not become a 45-minute match.
 *
 * The stage's rest gap *is* applied to every item, decided ones included. Rest belongs to the run,
 * not to the row — a placement match's 20-minute gap is a placement-stage fact, and the same match
 * is a 30-minute-rest anchor once the knockout pass is the one scheduling — which is why the
 * override is here rather than on the item.
 */
function resolveStageItems(
  items: readonly StageItem[],
  courts: readonly Court[],
  restGapMinutes: number,
): StageItem[] {
  const courtIdByNumber = new Map(courts.map((court) => [court.number, court.id]));
  return items.map((item) => {
    const base: StageItem = { ...item, restAfterMinutes: restGapMinutes };
    if (!item.fixed) return base;
    const courtId = item.courtNumber == null ? undefined : courtIdByNumber.get(item.courtNumber);
    return courtId == null ? { ...base, anchorOnly: true } : { ...base, resourceId: courtId };
  });
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
  stage: "placement" | "knockout";
  dayStart: Date;
  planningEnd: Date;
  hardEnd: Date | undefined;
  schedulingFloor: Date;
  courts: Court[];
  breaks: readonly TimeWindow[];
  items: StageItem[];
  slotMinutes: number;
  restGapMinutes: number;
  options?: DayOneSchedulerOptions | undefined;
}): StageRun {
  const { dayStart, planningEnd, hardEnd, schedulingFloor, courts, breaks, items } = input;
  const { restGapMinutes, options, slotMinutes } = input;

  const resolved = resolveStageItems(items, courts, restGapMinutes);

  const composed = composeDayPlan({
    matches: resolved,
    resources: courts.map((court) => ({
      id: court.id,
      order: court.number,
      label: `Court ${court.number}`,
    })),
    horizonStart: dayStart.getTime(),
    planningEnd: planningEnd.getTime(),
    hardEnd: hardEnd ? hardEnd.getTime() : null,
    floor: schedulingFloor.getTime(),
    breaks,
    ...(options ? { options } : {}),
  });

  const solution = composed.solution;
  return {
    slots: composed.slots,
    unscheduled: [...solution.unscheduled],
    utilization: solution.windowUtilization,
    overrun: solution.knownOverrun,
    overrunMinutes: solution.knownOverrunMinutes,
    deadlockReason: solution.diagnostics.deadlockReason,
    diagnostics: solution.diagnostics,
  };
}

export interface PlanDaysInput {
  orderedDays: readonly TournamentDay[];
  allCourts: readonly Court[];
  dayCourtIds?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  breaksByDayId?: ReadonlyMap<string, readonly TournamentDayBreak[]> | undefined;
  /** Placement-stage items, anchors included. */
  placementAll: readonly StageItem[];
  /** Knockout-stage items, anchors included. */
  knockoutAll: readonly StageItem[];
  placementSlotMinutes: number;
  placementRestGapMinutes: number;
  knockoutSlotMinutes: number;
  knockoutRestGapMinutes: number;
  isRebuild: boolean;
  nextWholeMinute: number;
  options?: DayOneSchedulerOptions | undefined;
  /**
   * Treat the other stage's fixed items as anchors in this stage too.
   *
   * Production leaves this off: it schedules forward from an empty day, so a knockout
   * can never already sit on a court before the placement work it would block. The
   * forecast turns it on, because it replays a partially placed tournament in which a
   * pinned knockout can share a day with work that has no row yet, and the two must
   * not be double-booked.
   */
  sharedAnchors?: boolean | undefined;
}

export interface PlanDaysResult {
  allSlots: ScheduledSlot[];
  days: PlacementDayFill[];
  /** Placement-stage item ids the queue could not place. */
  placementUnscheduled: string[];
  /** Knockout-stage item ids the queue could not place. */
  knockoutUnscheduled: string[];
  totalCapacityMinutes: number;
  usedMinutes: number;
  lastFinishMs: number | null;
  /** Latest planning end over every configured day. */
  lastPlanningEndMs: number;
  /** Planning end of the last day that actually has courts, or 0 when none has. */
  lastCourtDayPlanningEndMs: number;
  /** Configured days that actually have at least one court. */
  daysWithCourts: number;
  lastDiagnostics: SolverDiagnostics | null;
}

/**
 * Fills every day in turn — day one first, spilling into day two, and so on — so a
 * day's stage mix is an outcome rather than an input, and a day may carry the tail of
 * one stage and the head of the next.
 *
 * The stage barrier is real rather than advisory: the knockouts are only placed on
 * a day once every placement match has a slot. It is also already guaranteed by the
 * generators, because round two cannot exist until every round one result is in and
 * a knockout round cannot exist until the previous one is decided.
 */
export function runPlanDays(input: PlanDaysInput): PlanDaysResult {
  const {
    orderedDays,
    allCourts,
    dayCourtIds,
    breaksByDayId,
    placementAll,
    knockoutAll,
    placementSlotMinutes,
    placementRestGapMinutes,
    knockoutSlotMinutes,
    knockoutRestGapMinutes,
    isRebuild,
    nextWholeMinute,
    options,
    sharedAnchors,
  } = input;

  const everything = [...placementAll, ...knockoutAll];
  const knockoutIds = new Set(knockoutAll.map((item) => item.id));

  // The queue itself: what is still waiting for a slot. A match leaves its set only
  // when it has been given one, so anything that will not fit today is retried
  // tomorrow rather than silently dropped.
  const placementTodo = new Set(placementAll.filter((item) => !item.fixed).map((item) => item.id));
  const knockoutTodo = new Set(knockoutAll.filter((item) => !item.fixed).map((item) => item.id));
  const placementIds = new Set(placementAll.map((item) => item.id));

  const allSlots: ScheduledSlot[] = [];
  const dayFills: PlacementDayFill[] = [];
  let totalCapacityMinutes = 0;
  let usedMinutes = 0;
  let lastFinishMs: number | null = null;
  let lastPlanningEndMs = 0;
  let lastCourtDayPlanningEndMs = 0;
  let lastDiagnostics: SolverDiagnostics | null = null;

  /** This day's anchors, so a fixed match is counted on exactly one day. */
  const anchorsOn = (items: readonly StageItem[], dayKey: string) =>
    items.filter((item) => item.fixed && item.start != null && localDateKey(item.start) === dayKey);

  const daysWithCourts = orderedDays.filter(
    (day) => courtsForDay(allCourts, dayCourtIds?.get(day.id) ?? new Set()).length > 0,
  );
  const lastFilledDayId = daysWithCourts[daysWithCourts.length - 1]?.id ?? null;

  /**
   * Slots placed by an earlier day, handed to the days after it as anchors.
   *
   * A run builds its seed decided index from its own fixed items only, so a match placed on
   * Monday is invisible to Tuesday's run and anything depending on it can never be placed — it
   * deadlocks with a message that blames the day's window, and because one stuck placement match
   * also stops the knockout pass, a single unresolved prerequisite can refuse the whole build.
   *
   * That is not hypothetical: the two make-up matches of the placement format depend on other
   * round-two matches, so any tournament whose round two spans a day boundary hits it. Carrying the
   * earlier days' slots forward is what makes a dependency across midnight resolvable.
   *
   * These are anchors, not results: they are already in `allSlots`, so they are filtered back out of
   * every slot list below rather than recorded twice.
   *
   * The court is deliberately dropped. An earlier day's slot has no bearing on a later day's
   * courts — the days do not overlap in time — and a day is entitled to play on a different set of
   * courts, so naming one the later day does not have would fail the run's own validation and
   * refuse a build that is perfectly schedulable. The participant window is kept, because the rest
   * gap does cross midnight, and the end time is the whole point of the exercise.
   */
  const carriedAnchors: StageItem[] = [];
  const carriedIds = new Set<string>();
  const carrySlot = (slot: ScheduledSlot): StageItem => {
    const item = everything.find((entry) => entry.id === slot.matchId);
    return {
      id: slot.matchId,
      categoryId: slot.categoryId,
      participantIds: item?.participantIds ?? [],
      participantsKnown: item?.participantsKnown,
      durationMinutes: item?.durationMinutes ?? 0,
      // The rest gap crosses midnight even though the court does not, so it is carried.
      restAfterMinutes: item?.restAfterMinutes,
      groupKey: item?.groupKey ?? slot.categoryId,
      sequence: item?.sequence,
      softOrder: item?.softOrder,
      // No court on purpose: an earlier day's court has no bearing on a later day's,
      // and naming one the later day does not have would make the problem invalid.
      anchorOnly: true,
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
    lastCourtDayPlanningEndMs = Math.max(lastCourtDayPlanningEndMs, planningEnd.getTime());

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
     * Every placement slot this day holds, however it got there: the fixed matches
     * that were played on it, plus whatever pass A places on top.
     *
     * Built from the fixed matches rather than from pass A's output because pass A
     * is skipped entirely when nothing movable is left, and the knockout pass still
     * has to know which courts and participants this day has already used. A match
     * that overran its slot, or one still on court, holds its court for longer than
     * the clock suggests, so its window has to be handed over even though it is in
     * the past.
     */
    const placementShape = new Map<string, StageItem>();
    const placementAnchor = (item: {
      id: string;
      categoryId: string;
      participantIds: readonly string[];
      start?: number | undefined;
      end?: number | undefined;
      courtNumber?: number | undefined;
    }): StageItem | null =>
      item.start == null || item.end == null
        ? null
        : {
            id: item.id,
            categoryId: item.categoryId,
            participantIds: [...item.participantIds],
            participantsKnown: true,
            durationMinutes: placementSlotMinutes,
            restAfterMinutes: placementRestGapMinutes,
            groupKey: item.categoryId,
            sequence: 0,
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
        // The other stage's fixed work, when the caller is forecasting a partly
        // placed tournament: a pinned knockout already holds its court and players.
        ...(sharedAnchors ? anchorsOn(knockoutAll, dayKey) : []),
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
        slotMinutes: placementSlotMinutes,
        restGapMinutes: placementRestGapMinutes,
        options,
      });
      for (const slot of run.slots) {
        if (!placementTodo.has(slot.matchId)) continue;
        placementTodo.delete(slot.matchId);
        dayPlaced++;
      }
      // An earlier day's slots come back out of the run as echoes of their own
      // anchors. They are already recorded, so only this day's work joins the day. A
      // fixed item handed in from the other stage (the forecast does this) echoes too,
      // and must not be recorded as a placement.
      daySlots.push(
        ...run.slots.filter(
          (slot) => !carriedIds.has(slot.matchId) && placementIds.has(slot.matchId),
        ),
      );
      if (run.diagnostics) lastDiagnostics = run.diagnostics;
    }
    for (const slot of daySlots) {
      if (placementShape.has(slot.matchId)) continue;
      const anchor = placementAnchor({
        id: slot.matchId,
        categoryId: slot.categoryId,
        participantIds: everything.find((item) => item.id === slot.matchId)?.participantIds ?? [],
        start: slot.start.getTime(),
        end: slot.end.getTime(),
        courtNumber: slot.courtNumber,
      });
      if (anchor) placementShape.set(slot.matchId, anchor);
    }

    // Pass B — the knockouts. This is the barrier: they are only attempted once the
    // placement queue has drained, and every one of this day's placement slots is an
    // anchor, so the two stages cannot be double-booked onto one court or one participant.
    if (!placementTodo.size && knockoutTodo.size) {
      const anchors = [...placementShape.values()];
      const items: StageItem[] = [
        ...anchorsOn(knockoutAll, dayKey),
        ...anchors,
        ...carriedAnchors,
        ...knockoutAll.filter((item) => knockoutTodo.has(item.id)),
      ];
      const run = runStageForDay({
        stage: "knockout",
        dayStart,
        planningEnd,
        hardEnd,
        schedulingFloor,
        courts,
        breaks,
        items,
        slotMinutes: knockoutSlotMinutes,
        restGapMinutes: knockoutRestGapMinutes,
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

  return {
    allSlots,
    days: dayFills,
    placementUnscheduled: [...placementTodo].sort(),
    knockoutUnscheduled: [...knockoutTodo].sort(),
    totalCapacityMinutes,
    usedMinutes,
    lastFinishMs,
    lastPlanningEndMs,
    lastCourtDayPlanningEndMs,
    daysWithCourts: daysWithCourts.length,
    lastDiagnostics,
  };
}
