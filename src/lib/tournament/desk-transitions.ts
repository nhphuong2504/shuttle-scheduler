import { expectedEndMs, matchStartMs } from "./day-scope";
import type { DeskCourtState, DeskMatchModel } from "./desk";

const MINUTE = 60_000;

/**
 * Court transitions: what happens next on each court, as one venue-wide list.
 *
 * ## What this is, and what it deliberately is not
 *
 * The desk already answers "what is on court right now" (the board) and "what needs chasing"
 * (the Act-now alerts). What it had no compact answer for is the third question a moderator
 * asks while walking the hall: *which courts are about to change hands, and in what order*.
 *
 * A transition is that change. There are exactly two of them:
 *
 *   finish   a court is playing, and the match on it is approaching its expected end
 *   start    a court is free, and its next scheduled match is approaching its start
 *
 * ## No second schedule, no second readiness rule
 *
 * Both instants come from functions the desk already owns. A finish is
 * `expectedEndMs` - the same projection `awaitingResultMatches` and `dayOperationalCounts`
 * use to decide what is overdue - and a start is `matchStartMs`, the same "when is this match
 * attributed" rule the day bucketing uses. A match's duration comes from the caller's
 * `slotMinutesFor`, which is `deskKindPhase` resolved against the tournament's own timings, so
 * a group match and a knockout match are measured with their own slots here exactly as they
 * are everywhere else.
 *
 * That is the whole reason this module takes court states and a slot resolver rather than
 * reading a schedule: it cannot disagree with the board, because it is derived from the board.
 * There is no solver, no forecast, no placement decision and no reordering - and being pure, it
 * cannot have one added by accident.
 *
 * ## One transition per court
 *
 * A court on court yields its finish and *not* also the start of the match queued behind it.
 * The queued match cannot begin before the current one ends, so offering both would put a
 * countdown on an event that cannot happen on schedule - and it would spend two of the list's
 * rows on one court, which is the opposite of a venue-wide view. A court therefore contributes
 * at most its single next transition, and the list is ordered by when those fall due. That
 * bound is also what makes the default cap below exactly "one row per court".
 *
 * ## What is left out, on purpose
 *
 *   - **A court already over its expected finish** is not a transition - it is an overrun, and
 *     it already has a tile state and an Act-now alert. Counting it down here would be a third
 *     copy of one fact, so it is excluded rather than reworded.
 *   - **A match with no usable time** cannot be projected at all. `expectedEndMs` returns null
 *     and it is skipped, never counted down from a guess.
 *   - **A scheduled match with no court** has no court number to hang a transition on. It is a
 *     real condition, but it is the "ready, no court" alert's subject, not this panel's.
 *
 * ## Overdue starts are shown, without a countdown
 *
 * An unstarted match whose scheduled time has passed is surfaced by nothing else on the desk:
 * the overrun alert only covers a match that is *in progress*, and the pool alert cannot fire
 * on a tournament with no pools. So it is kept here and marked rather than hidden - with the
 * elapsed direction spelled out, because a countdown that has gone negative is the misleading
 * thing requirement 8 is about. It sorts to the top, which is where the most-overdue work
 * belongs.
 */

/** The two ways a court changes hands. Exported so a sweep can read the vocabulary, not restate it. */
export const COURT_TRANSITION_KINDS = ["finish", "start"] as const;

export type CourtTransitionKind = (typeof COURT_TRANSITION_KINDS)[number];

/**
 * The type label is the redundant channel that keeps the estimate/scheduled distinction from
 * resting on a colour or a tilde alone.
 *
 * "Expected finish" is worded as an estimate on purpose. The board shows what is happening;
 * this shows what is projected, and a projected end is a duration applied to a start time, not
 * a promise about the future.
 */
export const COURT_TRANSITION_LABEL: Record<CourtTransitionKind, string> = {
  finish: "Expected finish",
  start: "Scheduled start",
};

export interface CourtTransition<TMatch extends DeskMatchModel = DeskMatchModel> {
  courtId: string;
  kind: CourtTransitionKind;
  match: TMatch;
  /** The instant the transition falls due. */
  atMs: number;
  /** True when `atMs` is projected from a duration rather than read from the schedule. */
  estimated: boolean;
  /** True when `atMs` has already passed. Never carries a countdown. */
  overdue: boolean;
  /** Whole minutes until `atMs`, or null when overdue. Never zero. */
  minutesAway: number | null;
  /** Whole minutes `atMs` is in the past, or null when it is still ahead. */
  minutesOverdue: number | null;
}

/**
 * Whole minutes from `now` to `at`, never zero.
 *
 * `ceil` is what stops a transition that is twenty seconds away from rendering as "in 0 min",
 * which is not a countdown - it is a claim that the thing has arrived. Only ever called with
 * `at > now`, where `ceil` is guaranteed to be at least 1.
 */
function minutesUntil(at: number, now: number): number {
  return Math.ceil((at - now) / MINUTE);
}

/**
 * The next transitions across every court, soonest first, capped at `limit`.
 *
 * Read-only and pure: it returns the list and nothing else. Nothing here writes, dispatches or
 * reorders anything, and the caller renders it as information.
 *
 * ## The cap defaults to one row per court, not to a fixed number
 *
 * It was a constant five, which was a guess dressed as a limit: it truncated the list at a
 * count that had no relationship to the panel drawing it. The panel is stretched to share a
 * height with Court progress, which renders one row per court at the same `--row-height`, so
 * the list that fills it is exactly one row per court - and a smaller cap left unexplained
 * empty space at the panel's foot while the data to fill it was already in hand.
 *
 * Because a court contributes at most one transition (see above), `courtStates.length` is both
 * the maximum this function can return and the "show everything" case. So the default cannot
 * truncate in practice, and it cannot be wrong about the height either: the number of rows is
 * derived from the same court list the neighbouring panel is built from, so the two cannot
 * disagree. The parameter stays for a caller that has a real capacity other than one per
 * court, and for tests that need a shorter list.
 */
export function nextCourtTransitions<TMatch extends DeskMatchModel>(
  courtStates: readonly DeskCourtState<TMatch>[],
  slotMinutesFor: (match: TMatch) => number,
  now: number,
  limit: number = courtStates.length,
): CourtTransition<TMatch>[] {
  const transitions: CourtTransition<TMatch>[] = [];

  for (const court of courtStates) {
    const { playing, next } = court;

    if (playing) {
      const end = expectedEndMs(playing, slotMinutesFor);
      // No usable time means no projection. A finish already behind us is an overrun, which the
      // tile and the Act-now alert already report - neither is this panel's to restate.
      if (end == null || end <= now) continue;
      transitions.push({
        courtId: court.courtId,
        kind: "finish",
        match: playing,
        atMs: end,
        estimated: true,
        overdue: false,
        minutesAway: minutesUntil(end, now),
        minutesOverdue: null,
      });
      continue;
    }

    if (!next) continue;
    // A queued match is `scheduled` by construction, so this is its scheduled instant; it goes
    // through the shared attribution rule rather than a second parse of the same column.
    const start = matchStartMs(next);
    if (start == null) continue;

    const overdue = start <= now;
    transitions.push({
      courtId: court.courtId,
      kind: "start",
      match: next,
      atMs: start,
      estimated: false,
      overdue,
      minutesAway: overdue ? null : minutesUntil(start, now),
      minutesOverdue: overdue ? Math.floor((now - start) / MINUTE) : null,
    });
  }

  return transitions.sort((a, b) => a.atMs - b.atMs).slice(0, limit);
}

/** Countdown text for a transition that is still ahead. */
export function transitionCountdown(minutes: number): string {
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
}

/**
 * Elapsed text for a transition that is already late.
 *
 * The wording turns upward - "6 min overdue" rather than "-6 min" - so a number that has gone
 * negative can never be read as a countdown. Under a minute it says "overdue" with no number,
 * because "0 min overdue" reads as "on time".
 */
export function transitionOverdueBy(minutes: number): string {
  if (minutes < 1) return "overdue";
  if (minutes < 60) return `${minutes} min overdue`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h overdue` : `${hours}h ${rest}m overdue`;
}
