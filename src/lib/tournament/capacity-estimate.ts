import { totalMatchesInDraw } from "@/lib/tournament/draws";
import { requiredPlacementMatches } from "@/lib/tournament/placement";

/**
 * "Will it fit?": a rough count of the court time a field needs against the court time on
 * offer, so an organiser can see before registration opens whether the numbers are
 * plausible.
 *
 * It is advice, never a rule. The scheduler places matches by rest gaps and court overlap
 * and does not read this; a tournament that "does not fit" can still be built and simply
 * runs past the hours. It deliberately says nothing about utilisation targets (those were
 * removed from the forecast on purpose) - only "needs about X court-hours, has Y".
 *
 * ## The counts
 *
 * Placement: every entrant plays two matches and a match has two entrants, so a field of
 * N >= 3 plays N matches (one for N = 2, none for N = 1). Knockout: the entrants split
 * into the four draws by their record; with no results yet an even split is the best guess,
 * Draw D taking what is left over, and a draw of n entrants plays n - 1 matches whatever its
 * byes. The real split depends on results, so the knockout figure is an estimate.
 */
export const DEFAULT_PLACEMENT_SLOT_MINUTES = 20;
export const DEFAULT_KNOCKOUT_SLOT_MINUTES = 25;

/** The needed side, and the slot lengths, which are the same whatever the offered side is. */
interface CapacityBase {
  /** Expected entrants (players or pairs) in each event. */
  entrantsPerEvent: readonly number[];
  placementSlotMinutes?: number;
  knockoutSlotMinutes?: number;
}

/**
 * Court time offered as a product of the plan's own numbers.
 *
 * For a caller that has no configured days to read - the create flow's review, before any
 * day exists. The Schedule page has the days, and uses `OfferedCapacityInput` instead.
 */
export interface PlannedCapacityInput extends CapacityBase {
  courts: number;
  hoursPerDay: number;
  days: number;
}

/** Court time offered already totalled from the real days. */
export interface OfferedCapacityInput extends CapacityBase {
  courtHoursOffered: number;
}

/**
 * One of the two, never neither.
 *
 * A union rather than an optional field, because the two sides are answers to the same
 * question and a caller that supplies neither has no answer at all. `courtHoursOffered?` on a
 * flat interface would make that a runtime zero - the estimate would quietly read "the days
 * offer 0 court-hours" and call every tournament impossible, which is a wrong answer
 * presented with full confidence. Here the compiler asks for one of them.
 */
export type CapacityInput = PlannedCapacityInput | OfferedCapacityInput;

export type CapacityVerdict = "fits" | "tight" | "over";

export interface CapacityEstimate {
  placementMatches: number;
  knockoutMatches: number;
  courtHoursNeeded: number;
  courtHoursAvailable: number;
  verdict: CapacityVerdict;
}

/** Placement matches for a field of `n` entrants. */
export function placementMatchCount(n: number): number {
  const entrants = Math.max(Math.floor(n), 0);
  const perEntrant = requiredPlacementMatches(entrants);
  return perEntrant === 2 ? entrants : perEntrant === 1 ? 1 : 0;
}

/** Knockout matches for a field of `n` entrants, assuming an even split across the draws. */
export function knockoutMatchCount(n: number): number {
  const entrants = Math.max(Math.floor(n), 0);
  if (entrants < 2) return 0;
  const quarter = Math.floor(entrants / 4);
  const last = entrants - 3 * quarter;
  return 3 * totalMatchesInDraw(quarter) + totalMatchesInDraw(last);
}

export function estimateCapacity(input: CapacityInput): CapacityEstimate {
  const placementMinutes = input.placementSlotMinutes ?? DEFAULT_PLACEMENT_SLOT_MINUTES;
  const knockoutMinutes = input.knockoutSlotMinutes ?? DEFAULT_KNOCKOUT_SLOT_MINUTES;
  const placementMatches = input.entrantsPerEvent.reduce((sum, n) => sum + placementMatchCount(n), 0);
  const knockoutMatches = input.entrantsPerEvent.reduce((sum, n) => sum + knockoutMatchCount(n), 0);
  const courtHoursNeeded =
    (placementMatches * placementMinutes + knockoutMatches * knockoutMinutes) / 60;
  const courtHoursAvailable =
    "courtHoursOffered" in input
      ? Math.max(input.courtHoursOffered, 0)
      : Math.max(input.courts, 0) * Math.max(input.hoursPerDay, 0) * Math.max(input.days, 0);

  let verdict: CapacityVerdict = "fits";
  if (courtHoursNeeded > courtHoursAvailable) verdict = "over";
  // Within a tenth of capacity there is no room for a late start or a slow match.
  else if (courtHoursNeeded > courtHoursAvailable * 0.9) verdict = "tight";

  return { placementMatches, knockoutMatches, courtHoursNeeded, courtHoursAvailable, verdict };
}

export interface OfferedDay {
  /** Courts the day plays on. */
  courts: number;
  /** The day's window, in minutes. */
  windowMinutes: number;
  /** Breaks inside the window, in minutes; every court stops for them. */
  breakMinutes: number;
}

/** Court-hours on offer across the configured days: each day's courts x its window less breaks. */
export function courtHoursOffered(days: readonly OfferedDay[]): number {
  return days.reduce(
    (sum, day) =>
      sum + (Math.max(day.courts, 0) * Math.max(day.windowMinutes - day.breakMinutes, 0)) / 60,
    0,
  );
}
