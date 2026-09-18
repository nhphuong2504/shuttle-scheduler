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
    let start: number | null = null;
    if (match.status === "in-progress") {
      const anchor = match.started_at ?? match.scheduled_time;
      start = anchor ? Math.max(new Date(anchor).getTime(), now) : now;
    } else if (match.scheduled_time) {
      start = new Date(match.scheduled_time).getTime();
    }
    if (start == null) continue;
    const end = start + slotMinutes * 60_000;
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
