/**
 * The match-status vocabulary, and the distinction between a status and a draw condition.
 *
 * This module is presentation metadata, not domain logic. It answers one question - "how
 * should this persisted value be shown?" - and nothing here computes anything. It exists
 * because the answer was previously duplicated across four places that could disagree:
 *
 *   - `StatusPill` held the alias, label, tier and glyph tables
 *   - `tokens.test.ts` re-declared the alias map and the tier-4 sharing by hand
 *   - the render sites tested for byes three different ways
 *
 * That duplication is what let a pinned gap survive: a test that re-states a vocabulary
 * cannot notice the vocabulary has a hole in it. Deriving the tests from one source means
 * the next status cannot be half-added.
 */

/**
 * The five values the `CHECK` constraints permit on the match tables.
 *
 * Verified against the migrations rather than assumed: `pool_matches` and
 * `placement_matches` permit all five, and `draw_matches`/`tier_draw_matches` permit these plus
 * `bye` - which is handled separately below, because it is not a status in practice.
 */
export const PERSISTED_MATCH_STATUSES = [
  "scheduled",
  "in-progress",
  "reported",
  "walkover",
  "void",
] as const;

export type PersistedMatchStatus = (typeof PERSISTED_MATCH_STATUSES)[number];

/**
 * What a persisted status is presented as.
 *
 * Two statuses are renamed on the way to the screen - `in-progress` reads as "Live" and
 * `reported` reads as "Completed" - so the display vocabulary is not the storage
 * vocabulary, and keeping them as separate types makes that explicit rather than a
 * coincidence of matching strings.
 */
export type MatchDisplayState = "scheduled" | "live" | "completed" | "walkover" | "void";

export const MATCH_DISPLAY_STATE: Record<PersistedMatchStatus, MatchDisplayState> = {
  scheduled: "scheduled",
  "in-progress": "live",
  reported: "completed",
  walkover: "walkover",
  void: "void",
};

export const MATCH_DISPLAY_STATES = [
  "scheduled",
  "live",
  "completed",
  "walkover",
  "void",
] as const satisfies readonly MatchDisplayState[];

export const MATCH_DISPLAY_LABEL: Record<MatchDisplayState, string> = {
  scheduled: "Scheduled",
  live: "Live",
  completed: "Completed",
  walkover: "Walkover",
  void: "Void",
};

/**
 * The four lightness tiers, which decide how a state is drawn rather than what it says.
 *
 *   tier 1  saturated chip   live
 *   tier 2  shared amber     (no consumer - see the note below)
 *   tier 3  neutral chip     scheduled, void
 *   tier 4  NO chip          walkover, completed
 *
 * `void` is deliberately tier 3: it is a filled neutral chip, which is what makes it
 * legible as an exception rather than as absent data.
 *
 * No state sits in tier 2. The amber tier was built for `paused` and `called`, both of
 * which were deleted as phantom states once reconnaissance showed the schema cannot
 * produce them, so the slot is currently unoccupied and the mapping says so rather than
 * inventing a consumer for the hue. The tier numbering is kept because renumbering would
 * churn every reference for no gain, and a future amber state has a documented home.
 */
export const MATCH_DISPLAY_TIER: Record<MatchDisplayState, 1 | 2 | 3 | 4> = {
  live: 1,
  scheduled: 3,
  void: 3,
  walkover: 4,
  completed: 4,
};

/**
 * Tier 4 states are ink-only, so they have no chip token.
 *
 * Derived from the tier map rather than listed again, because a list that can disagree
 * with the tier map is exactly the shape of bug this module exists to remove.
 */
export const TIER4_DISPLAY_STATES: readonly MatchDisplayState[] = MATCH_DISPLAY_STATES.filter(
  (state) => MATCH_DISPLAY_TIER[state] === 4,
);

/**
 * `bye` is permitted by two constraints and written by nothing.
 *
 * `draw_matches` and `tier_draw_matches` both allow `status = 'bye'`, which makes it look like a
 * status. It is not: the generator writes a bye as
 *
 *     status: "reported", note: "Bye", is_bye: true, winner_id: <the solo entrant>
 *
 * - a match that is already decided, with the marker kept in `note` and `is_bye`. So the
 * permitted `'bye'` value is vestigial, and nothing in the app ever reads it. It is named
 * here so the distinction is recorded rather than rediscovered, and so no display table
 * grows a "bye" entry that would invent a status the data never carries.
 */
export const VESTIGIAL_MATCH_STATUSES = ["bye"] as const;

/** The marker the generator writes on a bye row. */
export const BYE_NOTE = "Bye";

/** The fields that can identify a bye, as they arrive from any of the four match tables. */
export interface ByeCandidate {
  is_bye?: boolean | null;
  note?: string | null;
}

/**
 * Whether a row is a bye - that is, a draw condition rather than a played match.
 *
 * Both signals are accepted because they are both really written and the app previously
 * checked one or the other depending on the file, so a row that carried only one of them
 * would have been drawn differently on two pages. Reading either is a superset of both
 * behaviours, so nothing that used to be treated as a bye stops being one.
 *
 * This is used for rendering only. It is deliberately not a scheduling predicate: the
 * scheduler's own bye handling reads `is_bye` directly, and this must not become a second
 * opinion that could drift from it.
 */
export function isByeMatch(match: ByeCandidate): boolean {
  return match.is_bye === true || match.note === BYE_NOTE;
}

/** Resolves a persisted status to its display state, or null when unrecognised. */
export function displayStateFor(status: string): MatchDisplayState | null {
  return (MATCH_DISPLAY_STATE as Record<string, MatchDisplayState | undefined>)[status] ?? null;
}
