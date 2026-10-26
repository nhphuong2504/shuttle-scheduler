/**
 * How a published time is written: on a whole minute, and only when it moves far enough to matter.
 *
 * Viet Nam Open 2026 published 307 of its 309 reflowed times with seconds (14:03:14), and 186 of
 * those moves were under a minute, so the board changed after almost every result. The rule now is
 * the one `20261026000000_whole_minute_published_times.sql` applies in the database:
 *
 * - **Round up, never to nearest.** A start rounded down could begin before the court is free or a
 *   player has rested; rounded up it never can.
 * - **A move under the threshold is not written.** The reflow still computes it, and still places
 *   the matches behind it from it, but the published time stays. Every run measures from the stored
 *   time, so the gap never builds past the threshold.
 *
 * The threshold has two readers besides the reflow, and they must agree with it or a match the
 * reflow deliberately left alone is reported as broken: `schedule_conflicts` (a published time up to
 * the threshold inside a real finish is not a conflict) and the planner (it does not drop or
 * release a published row for the same gap). `SCHEDULE_SHIFT_THRESHOLD_MS` is pinned to the SQL
 * function `schedule_shift_threshold()` by `db-invariants.test.ts`.
 */

export const MINUTE_MS = 60_000;

/** The smallest move of a published time worth writing. Mirrors `schedule_shift_threshold()`. */
export const SCHEDULE_SHIFT_THRESHOLD_MS = 2 * MINUTE_MS;

/** `ms` on the next whole minute, or itself when it already is one. Mirrors `ceil_to_minute()`. */
export function ceilToMinute(ms: number): number {
  return Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
}
