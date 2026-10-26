import { inProgressEnd } from "./in-progress";
import type { ScheduledSlot } from "./scheduling/types";

export type PlanChangeKind =
  "unchanged" | "time-moved" | "court-moved" | "both-moved" | "newly-placed";

export interface PlanChange {
  matchId: string;
  kind: PlanChangeKind;
  fromStart: string | null;
  toStart: string;
  fromCourtNumber: number | null;
  toCourtNumber: number;
  shiftMinutes: number;
  /**
   * The tournament day this match lands on after the plan, by the planner's own attribution rule
   * (the last day that had already opened, `sliceRowsByDay`). Null for a plan that is not
   * day-scoped, which is why the preview groups by it rather than requiring it.
   *
   * Without it a list of moves carries bare `HH:MM` values across several days, and a reader
   * cannot tell which day a time belongs to.
   */
  dayNumber?: number | null;
  /**
   * Whether the match starts within `SOON_MINUTES` of the moment the plan was made.
   *
   * This is the cost a rebuild is really paid in: moving a match that starts in twelve minutes
   * is a different act from moving one on Thursday. The invitation card already counts these
   * (`rebuild-suggestion.ts`); the preview has to show them, or it prices every move the same.
   */
  startsSoon?: boolean;
  /** True for a row the plan places for the first time, which is not a move. */
  isNew?: boolean;
}

export interface SchedulePlanDiff {
  changes: PlanChange[];
  anchorCount: number;
  placedCount: number;
  movedCount: number;
  newlyPlacedCount: number;
  largestShiftMinutes: number;
  unplaceable: string[];
}

export interface DiffMatchRow {
  id: string;
  scheduled_time: string | null;
  court_id: string | null;
}

export interface RemainingMatchRow {
  status: string;
  scheduled_time: string | null;
  started_at?: string | null;
}

/** Latest predicted end among matches still scheduled or in progress. */
export function projectedFinishFromRemainingMatches(
  matches: readonly RemainingMatchRow[],
  slotMinutes: number,
  now = Date.now(),
): number | null {
  let latest: number | null = null;
  for (const match of matches) {
    if (match.status !== "scheduled" && match.status !== "in-progress") continue;
    let end: number | null = null;
    if (match.status === "in-progress") {
      // The same model the planner and the database use: its slot, and no earlier than now once it overruns.
      const anchor = match.started_at ?? match.scheduled_time;
      end = inProgressEnd({
        start: anchor ? new Date(anchor).getTime() : now,
        slotMs: slotMinutes * 60_000,
        now,
      });
    } else if (match.scheduled_time) {
      end = new Date(match.scheduled_time).getTime() + slotMinutes * 60_000;
    }
    if (end == null) continue;
    latest = latest == null ? end : Math.max(latest, end);
  }
  return latest;
}

export function formatProjectedFinishDelta(deltaMinutes: number): string {
  if (deltaMinutes === 0) return "Same finish as the current schedule";
  const abs = Math.abs(deltaMinutes);
  if (deltaMinutes > 0) return `${abs} min later than the current schedule`;
  return `${abs} min earlier than the current schedule`;
}

/**
 * When the schedule as it stands would finish, across both stages.
 *
 * This is the number a rebuild has to be read against, and it is deliberately one function: the
 * page header and the preview both call it, so "the schedule finishes at 13:11" cannot mean one
 * thing above the dialog and another inside it. Each stage is measured with its own slot length,
 * and the later of the two wins, because the two run on the same court pool.
 *
 * Matches with no time contribute nothing - they are not part of a finish that is already
 * claimed to exist.
 */
export function currentFinishFor(input: {
  placementMatches: readonly RemainingMatchRow[];
  tierMatches: readonly RemainingMatchRow[];
  placementSlotMinutes: number;
  knockoutSlotMinutes: number;
  now?: number;
}): number | null {
  const now = input.now ?? Date.now();
  const placement = projectedFinishFromRemainingMatches(
    input.placementMatches,
    input.placementSlotMinutes,
    now,
  );
  const knockout = projectedFinishFromRemainingMatches(
    input.tierMatches,
    input.knockoutSlotMinutes,
    now,
  );
  return Math.max(placement ?? 0, knockout ?? 0) || null;
}

/** The threshold the invitation card uses, so "soon" means one thing across both surfaces. */
export const SOON_MINUTES = 60;

/**
 * Whether a match's current start is close enough that moving it is felt at the desk.
 *
 * A match with no start (one the plan places for the first time) is not "soon": there is no
 * published time to be read off the running order yet.
 */
export function startsSoon(
  fromStart: string | null,
  now: number,
  soonMinutes = SOON_MINUTES,
): boolean {
  if (fromStart == null) return false;
  const ms = Date.parse(fromStart);
  if (!Number.isFinite(ms)) return false;
  const ahead = ms - now;
  return ahead <= soonMinutes * 60_000;
}

/**
 * How one day's finish compares, before and after a plan.
 *
 * `moved` counts matches that already had a court and a time and get a different one. `newlyPlaced`
 * is kept apart on purpose: a first build places everything, and reporting that as "moves" would
 * tell the organiser that a schedule they never had is being taken away from them.
 */
export interface DayFinishComparison {
  dayNumber: number;
  /** The day's date, `YYYY-MM-DD`, as configured. */
  date: string;
  finishNowMs: number | null;
  finishAfterMs: number | null;
  moved: number;
  newlyPlaced: number;
  /** The largest single shift among this day's moves, in minutes. */
  largestShiftMinutes: number;
  overrunAfterMinutes: number;
}

function courtNumber(
  courtId: string | null,
  courtNumberById: ReadonlyMap<string, number>,
): number | null {
  if (!courtId) return null;
  return courtNumberById.get(courtId) ?? null;
}

function classifyChange(
  fromStart: string | null,
  toStart: string,
  fromCourt: number | null,
  toCourt: number,
): PlanChangeKind {
  const timeChanged = fromStart !== toStart;
  const courtChanged = fromCourt !== toCourt;
  if (!fromStart && fromCourt == null) return "newly-placed";
  if (timeChanged && courtChanged) return "both-moved";
  if (timeChanged) return "time-moved";
  if (courtChanged) return "court-moved";
  return "unchanged";
}

export function diffPlan(
  currentMatches: DiffMatchRow[],
  slots: ScheduledSlot[],
  fixedMatchIds: ReadonlySet<string>,
  courtNumberById: ReadonlyMap<string, number>,
): SchedulePlanDiff {
  const currentById = new Map(currentMatches.map((match) => [match.id, match]));
  const movableSlots = slots.filter((slot) => !fixedMatchIds.has(slot.matchId));
  const changes: PlanChange[] = [];
  let movedCount = 0;
  let newlyPlacedCount = 0;
  let largestShiftMinutes = 0;

  for (const slot of movableSlots) {
    const current = currentById.get(slot.matchId);
    const fromStart = current?.scheduled_time ?? null;
    const toStart = slot.start.toISOString();
    const fromCourtNumber = courtNumber(current?.court_id ?? null, courtNumberById);
    const toCourtNumber = slot.courtNumber;
    const kind = classifyChange(fromStart, toStart, fromCourtNumber, toCourtNumber);
    const shiftMinutes =
      fromStart != null
        ? Math.round((slot.start.getTime() - new Date(fromStart).getTime()) / 60_000)
        : 0;

    changes.push({
      matchId: slot.matchId,
      kind,
      fromStart,
      toStart,
      fromCourtNumber,
      toCourtNumber,
      shiftMinutes,
    });

    if (kind === "newly-placed") newlyPlacedCount++;
    else if (kind !== "unchanged") movedCount++;
    largestShiftMinutes = Math.max(largestShiftMinutes, Math.abs(shiftMinutes));
  }

  changes.sort(
    (a, b) =>
      new Date(a.toStart).getTime() - new Date(b.toStart).getTime() ||
      a.toCourtNumber - b.toCourtNumber ||
      a.matchId.localeCompare(b.matchId),
  );

  return {
    changes,
    anchorCount: fixedMatchIds.size,
    placedCount: movableSlots.length,
    movedCount,
    newlyPlacedCount,
    largestShiftMinutes,
    unplaceable: [],
  };
}
