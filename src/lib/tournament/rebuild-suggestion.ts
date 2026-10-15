/**
 * When to tell the organiser that rebuilding the schedule would be worth it.
 *
 * The automatic pass places new matches without moving anything, and that is the right default. Past a
 * point, though, a rebuild finishes the day noticeably sooner: when the day is tight, or the field is
 * large, gap-filling leaves matches without a time or settles for a later finish. The organiser decides
 * whether that is worth moving published times, so the page says so, with the cost stated, and opens the
 * rebuild preview. Nothing here applies anything.
 *
 * Pure: the caller does the dry-run plan and passes in what it found.
 */

import type { SchedulePlanDiff } from "./schedule-diff";

const MINUTE = 60_000;

/** A rebuild must finish at least this much sooner before it is worth a mention. */
export const MIN_FINISH_GAIN_MINUTES = 30;

/** A match starting within this long counts as "soon" when the cost is stated. */
export const SOON_MINUTES = 60;

export interface RebuildSuggestion {
  /** Minutes sooner the whole queue would finish. */
  finishGainMinutes: number;
  /** Matches that already have a time and would get a different one. */
  movedCount: number;
  /** Of those, how many currently start within the hour. */
  movedSoonCount: number;
  headline: string;
  detail: string;
}

export function buildRebuildSuggestion(input: {
  /** When the queue finishes as scheduled now, or null with nothing left to play. */
  currentFinishMs: number | null;
  /** When it would finish after the rebuild, judged the same way. */
  plannedFinishMs: number | null;
  /** A rebuild that cannot place every match is not an improvement to offer. */
  blockedCount: number;
  diff: Pick<SchedulePlanDiff, "changes" | "movedCount">;
  now: number;
  minGainMinutes?: number;
}): RebuildSuggestion | null {
  const { currentFinishMs, plannedFinishMs, blockedCount, diff, now } = input;
  const minGain = input.minGainMinutes ?? MIN_FINISH_GAIN_MINUTES;
  if (blockedCount > 0) return null;
  if (currentFinishMs == null || plannedFinishMs == null) return null;

  const gain = Math.round((currentFinishMs - plannedFinishMs) / MINUTE);
  if (gain < minGain) return null;

  const moved = diff.changes.filter(
    (change) => change.kind !== "unchanged" && change.kind !== "newly-placed" && change.fromStart != null,
  );
  const movedCount = moved.length;
  // Finishing sooner by shuffling nothing is not a rebuild's doing; there is nothing to offer.
  if (movedCount === 0) return null;
  const movedSoonCount = moved.filter(
    (change) => Date.parse(change.fromStart as string) - now <= SOON_MINUTES * MINUTE,
  ).length;

  const headline = `A rebuild would finish ${describeMinutes(gain)} sooner`;
  const detail =
    `It would move ${movedCount} match${movedCount === 1 ? "" : "es"}` +
    soonClause(movedCount, movedSoonCount) +
    ". Nothing changes until you review and apply it.";

  return { finishGainMinutes: gain, movedCount, movedSoonCount, headline, detail };
}

function soonClause(moved: number, soon: number): string {
  if (soon === 0) return ", none starting within the hour";
  if (soon === moved) return moved === 1 ? ", starting within the hour" : ", all starting within the hour";
  return `, ${soon} of them starting within the hour`;
}

/** `55 min`, or `1 h 10 min` once it is an hour or more. */
export function describeMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
