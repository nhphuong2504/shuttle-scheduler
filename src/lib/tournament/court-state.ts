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
 * `playing` reuses the match `live` tokens deliberately rather than minting a
 * second green. The two encode the same fact from different vantage points - a
 * match is live, therefore its court is playing - and they never co-render, so a
 * separate green would be a distinction the reader can see but cannot use. The
 * state is not a match status, but the colour can be shared.
 */
export const COURT_STATE_CHIP: Record<CourtState, string> = {
  playing: "bg-state-live-chip text-state-live-ink",
  overrun: "bg-danger-surface text-danger-foreground",
  // `/10`, not the `/12` this started as, because `/12` is a tint no ink was solved
  // against. `--primary-ink` was solved against `bg-primary/10` in phase 3; carrying a
  // slightly darker tint here put the pair at 4.41:1, under the 4.5:1
  // that 14px needs, and nothing could see it: this chip only exists on a court board
  // with a tournament in it, so the only scan that had ever run had no tile to measure.
  // Reusing the validated tint is the principled fix - a second tint would mean a
  // second ink, and the design's rule is one ink pair per fill.
  "free-ready": "bg-primary/10 text-primary-ink",
  "free-blocked": "bg-warn-surface text-warn-foreground",
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
 * the "Playing" chip had no edge at all and read as uppercase text on green. Measured
 * on the rendered board, the pill's fill was byte-identical to its own tile's -
 * 1.000:1, against 1.087:1 for the weakest other state. `states.spec.ts`
 * now sweeps every pill against its own tile, and `court-state.test.ts` asserts the
 * two fills differ at the vocabulary level so the collision cannot return.
 *
 * `free-blocked` and `idle` share the resting hairline on purpose. Neither asks for
 * anything, and giving the blocked state its own edge would put two amber surfaces
 * on one tile - the pill already carries that signal, and doubling it would make a
 * waiting court look more urgent than an overrun one.
 */
export const COURT_STATE_TILE: Record<CourtState, string> = {
  playing: "border-state-live-ink/35 bg-state-live-chip/30",
  overrun: "border-danger-border bg-danger-surface/40",
  "free-ready": "border-primary/40 bg-primary/5",
  "free-blocked": "border-hairline bg-surface",
  idle: "border-hairline bg-surface",
};

/** Narrows a derived state to the vocabulary. */
export function isCourtState(value: string): value is CourtState {
  return (COURT_STATES as readonly string[]).includes(value);
}
