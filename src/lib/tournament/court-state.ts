/**
 * The court-state vocabulary, in one place.
 *
 * The counterpart to `match-status.ts`, and extracted for the same reason. A court
 * state is not a match status and the two must not be conflated:
 *
 *   match status   what happened to one match      persisted, a closed schema set
 *   court state    what a court is doing right now derived, never stored
 *
 * Both were previously spelled out as literal maps inside the components that drew
 * them, which meant the vocabulary existed only as long as nobody needed it twice.
 * Phase 6 sweeps all five states through the rendered app, and a sweep has to read
 * the vocabulary from the same source the app renders from - otherwise it confirms
 * a list it restated itself, which is how `void` stayed invisible for three phases.
 *
 * The derivation rule lives in `desk.ts` (`deriveCourtState`), which imports the
 * type below so the set of states and the function that produces them cannot drift.
 */

export const COURT_STATES = ["playing", "overrun", "free-ready", "free-blocked", "idle"] as const;

export type CourtState = (typeof COURT_STATES)[number];

/**
 * The label is the redundant channel that keeps colour from being the only signal.
 *
 * The four states a moderator must act on read as different sentences rather than
 * as different tints: `playing` is fine, `overrun` needs attention, `free-ready`
 * needs a match dispatched to it, and `free-blocked` is waiting on something that
 * may need chasing.
 */
export const COURT_STATE_LABEL: Record<CourtState, string> = {
  playing: "Playing",
  overrun: "Overrun",
  "free-ready": "Ready",
  "free-blocked": "Waiting",
  idle: "Idle",
};

/**
 * The pill's fill and ink.
 *
 * The court's own green, under its own token rather than the match `live` one. A court
 * state and a match status are different vocabularies, and `--state-live-*` also paints
 * the "Live" match chip, the Desk's status badge and the ConnectionBadge - so sharing it
 * would move all four together. The two greens hold the same value today, so they agree
 * on screen; the separation is about the names, and it is what lets one be retuned
 * without silently re-tinting the other.
 */
export const COURT_STATE_CHIP: Record<CourtState, string> = {
  playing: "bg-play-surface text-play-foreground ring-1 ring-inset ring-play-foreground/60",
  // A delay, not a danger: amber, with a ring so it stays a surface next to the neutral Waiting.
  overrun: "bg-warn-surface text-warn-foreground ring-1 ring-inset ring-warn-border",
  // `/10`, not the `/12` this started as, because `/12` is a tint no ink was solved
  // against. `--primary-ink` was solved against `bg-primary/10` in phase 3; carrying a
  // slightly darker tint here put the pair at 4.41:1, under the 4.5:1
  // that 14px needs, and nothing could see it: this chip only exists on a court board
  // with a tournament in it, so the only scan that had ever run had no tile to measure.
  // Reusing the validated tint is the principled fix - a second tint would mean a
  // second ink, and the design's rule is one ink pair per fill.
  "free-ready": "bg-primary/10 text-primary-ink",
  // Waiting asks nothing of the moderator; the reason beneath it explains. Neutral, but a
  // deeper grey than `idle` so the two chips stay distinct fills.
  "free-blocked": "bg-foreground/15 text-foreground",
  idle: "bg-muted text-muted-foreground",
};

/**
 * The tile's own edge and tint.
 *
 * A second, independent channel from the pill: the pill is read on one court, the
 * tile tint is what makes a wall of eight courts scannable without reading any of
 * them. Both derive from the same state, so they cannot disagree.
 *
 * The tile is a *wash* of the state and the pill is the denser surface, in every
 * state without exception. `playing` was the exception and it was a defect: its tile
 * painted the full `--state-live-chip`, which is the same fill the pill paints, so
 * the "Playing" chip had no edge at all and read as uppercase text with no edge. Measured
 * on the rendered board, the pill's fill was byte-identical to its own tile's -
 * 1.000:1, against 1.087:1 for the weakest other state. `states.spec.ts`
 * now sweeps every pill against its own tile, and `court-state.test.ts` asserts the
 * two fills differ at the vocabulary level so the collision cannot return.
 *
 * Only the states that ask something of the moderator tint the whole tile: `overrun` amber and
 * `free-ready` primary, each its family's edge over a wash of its own fill, with the chip that
 * same fill at full strength on top. Their edges are distinct, which the sweep in
 * `states.spec.ts` requires of every actionable state.
 *
 * `playing`, `free-blocked` and `idle` ask for nothing, so they keep the resting hairline.
 * `playing` used to take a green wash and edge too, and on a live day most courts are playing:
 * the board became a field of green that the two states needing a hand had to compete with.
 * Its green now lives in the chip alone, which is still a filled, ringed surface on a white
 * tile. `free-blocked` stays neutral for the same reason - giving it an edge would put two amber
 * surfaces on one tile and make a waiting court look more urgent than an overrun one - and
 * `idle` is set apart by its muted wash.
 */
export const COURT_STATE_TILE: Record<CourtState, string> = {
  playing: "border-hairline bg-surface",
  overrun: "border-warn-border bg-warn-surface/40",
  "free-ready": "border-primary/40 bg-primary/5",
  "free-blocked": "border-hairline bg-surface",
  // Idle is dimmed by colour rather than opacity: a muted wash reads as "nothing here" at a
  // glance and still leaves the pill (its own, deeper muted fill) a surface to sit on.
  idle: "border-hairline bg-muted/60",
};

/** Narrows a derived state to the vocabulary. */
export function isCourtState(value: string): value is CourtState {
  return (COURT_STATES as readonly string[]).includes(value);
}
