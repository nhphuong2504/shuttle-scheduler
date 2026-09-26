/**
 * The competition format this app runs.
 *
 * Exactly one format is supported, so it is described once here and rendered by
 * the creation wizard's Structure step and its review summary. This module is the
 * shared *description* of the format; the engine that generates matches lives in
 * `placement.ts` (pairing, make-up matches, tiers), `tier-draw.ts` (the A/B/C/D
 * brackets) and `placement-seed.ts` (skill-block seeding). Keeping the prose here
 * rather than inside the engine is what stops the wizard and the engine from
 * describing the format differently.
 *
 * Structure: a two-round placement stage, then A/B/C/D single-elimination draws.
 * An entrant's two placement results determine their draw:
 *
 *   WW -> A, WL -> B, LW -> C, LL -> D
 *
 * An odd entry count does not need a bye, and in fact the placement stage has no
 * concept of one: it *holds* one entrant out of round one, and that entrant then
 * plays two make-up matches in round two, one against a round-one winner and one
 * against a round-one loser. Every entrant therefore plays exactly twice and
 * reaches a draw with a complete record.
 */

export type PlacementRecord = "WW" | "WL" | "LW" | "LL";
export type DrawTier = "A" | "B" | "C" | "D";

export interface PlacementTierMapping {
  record: PlacementRecord;
  tier: DrawTier;
  /** How the tier reads to a host, e.g. "Draw A". */
  label: string;
  /** The competitive meaning, e.g. "Cup". */
  title: string;
  detail: string;
}

/** Placement record to knockout draw. The order is the presentation order. */
export const PLACEMENT_TIERS: PlacementTierMapping[] = [
  {
    record: "WW",
    tier: "A",
    label: "Draw A",
    title: "Cup",
    detail: "Won both placement matches.",
  },
  {
    record: "WL",
    tier: "B",
    label: "Draw B",
    title: "Plate",
    detail: "Won the first placement match, lost the second.",
  },
  {
    record: "LW",
    tier: "C",
    label: "Draw C",
    title: "Bowl",
    detail: "Lost the first placement match, won the second.",
  },
  {
    record: "LL",
    tier: "D",
    label: "Draw D",
    title: "Shield",
    detail: "Lost both placement matches.",
  },
];

export function tierForRecord(record: PlacementRecord): DrawTier {
  const found = PLACEMENT_TIERS.find((entry) => entry.record === record);
  if (!found) throw new Error(`Unknown placement record: ${record}`);
  return found.tier;
}

export function recordForTier(tier: DrawTier): PlacementRecord {
  const found = PLACEMENT_TIERS.find((entry) => entry.tier === tier);
  if (!found) throw new Error(`Unknown draw tier: ${tier}`);
  return found.record;
}

export interface CompetitionFormat {
  id: "two_round_placement";
  name: string;
  summary: string;
  placement: {
    name: string;
    rounds: number;
    /** Placement matches each entrant plays. */
    matchesPerEntrant: number;
    detail: string;
  };
  knockout: {
    name: string;
    elimination: string;
    detail: string;
  };
  tiers: PlacementTierMapping[];
}

export const SUPPORTED_FORMAT: CompetitionFormat = {
  id: "two_round_placement",
  name: "Two-round placement, then A/B/C/D knockout",
  summary:
    "Every entrant plays two placement matches. The two results sort entrants into four single-elimination draws, which run to a winner.",
  placement: {
    name: "Placement stage",
    rounds: 2,
    matchesPerEntrant: 2,
    detail:
      "Round one pairs entrants up. Winners meet winners and losers meet losers in round two, so every entrant plays exactly two matches. With an odd entry count one entrant is held out of round one and plays both matches in round two: one against a round-one winner, one against a round-one loser.",
  },
  knockout: {
    name: "Knockout draws",
    elimination: "Single elimination",
    detail:
      "Each draw is a single-elimination bracket that runs to a winner. Draw D absorbs any extra entrants.",
  },
  tiers: PLACEMENT_TIERS,
};

/**
 * Whether a tournament's stored `format` is the one this app creates and runs.
 *
 * Both engines' tables live in the same database, and the live surfaces used to merge
 * them so one board could carry either format. That merge is wrong for the supported
 * format: a two-round placement tournament has no pools, so `pools`, `pool_matches`,
 * `draws` and `draw_matches` rows under one are leftovers — and listing them as results
 * puts finished matches this event cannot have above the matches it is actually playing.
 *
 * The stored value is read rather than the rows inferred, deliberately: an empty table
 * is not evidence of a format, and `data.ts` keeps the two sets of hooks apart precisely
 * so no hook has to guess which format it is looking at.
 *
 * Only `two_round_placement` returns true. A `null` format is not the supported one —
 * `createTournament` defaults the column, so a null means the row was written around
 * the app, and guessing "placement" for it would hide a round-robin event's own matches.
 */
export function isSupportedFormat(format: string | null | undefined): boolean {
  return format === SUPPORTED_FORMAT.id;
}

/** A one-line explanation of the placement rule, for dense UI. */
export function placementRuleSummary(): string {
  return PLACEMENT_TIERS.map((entry) => `${entry.record} → ${entry.tier}`).join(", ");
}

/**
 * How an odd entry count is handled.
 *
 * This used to be a blocker: two rounds only produce WW/WL/LW/LL for an even
 * field, and the fix was undecided. It is decided now — the placement stage holds
 * one entrant rather than issuing a bye, so an odd count needs no special casing
 * anywhere. This function returns a host-facing explanation of that, or null when
 * the count is even, so the UI can still call attention to the held entrant.
 */
export function entrantCountNote(entrantCount: number | null): string | null {
  if (entrantCount == null || entrantCount <= 2) return null;
  if (entrantCount % 2 === 0) return null;
  return (
    "One entrant is held out of round one and plays both of their placement matches in round two, " +
    "so nobody has a bye and everyone still plays exactly twice."
  );
}
