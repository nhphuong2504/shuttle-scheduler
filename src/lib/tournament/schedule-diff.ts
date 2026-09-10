import type { ScheduledSlot } from "./scheduler";

export type PlanChangeKind =
  | "unchanged"
  | "time-moved"
  | "court-moved"
  | "both-moved"
  | "newly-placed";

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
