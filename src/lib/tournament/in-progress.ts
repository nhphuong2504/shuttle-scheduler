/**
 * When a match that is on court now is expected to end.
 *
 * One definition for every place that has to guess, so the planner, the Desk's finish forecast and the
 * database agree. The live reflow (`shift_live_schedule_core`) and `placement_occupied_matches` take
 * `GREATEST(start + slot, now)`: a running match ends when its slot is up, and once it has overrun it is
 * assumed to end "now", because nothing says when. This is the same. `schedule_conflicts` does not: it asks
 * whether the plan contradicts itself, so it gives a running match its planned span (section 33).
 *
 * The planner used to say `now + slot` instead, a full slot from the moment of planning no matter how
 * long the match had already been playing. That reserved every running court (and its players) for time
 * that had already been used, which left courts idle and made each rebuild push published times later.
 *
 * This is an estimate of a planned time, not a lock. Whether another match may START on a court is decided
 * by status alone (`assert_can_start_match`): a court with a match in progress is busy until that match is
 * reported, whatever this says. An overrun therefore never lets two matches share a court; at worst the
 * next match is published for a moment when the court is still busy, and the reflow re-times it when the
 * result lands.
 *
 * Rounded to whole milliseconds because the scheduling problem rejects two fixed matches on one court
 * that overlap at all, and a fractional end followed by a truncated start can overlap by under a
 * millisecond.
 */
export function inProgressEnd(input: { start: number; slotMs: number; now: number }): number {
  return Math.round(Math.max(input.start + input.slotMs, input.now));
}
