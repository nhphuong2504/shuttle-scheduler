/**
 * The competition format this app runs.
 *
 * Exactly one format is supported, so it is described once here and rendered by
 * the creation wizard's Structure step and its review summary. The engine that
 * actually generates matches is not built yet; this module is the shared
 * description of the format the engine will have to implement, kept in one place
 * so the wizard and the future engine cannot drift apart.
 *
 * Structure: a two-round placement stage, then A/B/C/D single-elimination draws.
 * An entrant's two placement results determine their draw:
 *
 *   WW -> A, WL -> B, LW -> C, LL -> D
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
      "Round one pairs entrants up. Winners meet winners and losers meet losers in round two, so every entrant plays exactly two matches.",
  },
  knockout: {
    name: "Knockout draws",
    elimination: "Single elimination",
    detail:
      "Each draw is a single-elimination bracket that runs to a winner. Draw D absorbs any extra entrants.",
  },
  tiers: PLACEMENT_TIERS,
};

/** A one-line explanation of the placement rule, for dense UI. */
export function placementRuleSummary(): string {
  return PLACEMENT_TIERS.map((entry) => `${entry.record} → ${entry.tier}`).join(", ");
}

/**
 * Whether a category can run this format as specified. Two placement rounds
 * produce the WW/WL/LW/LL records only when the entrant count is even, so an odd
 * count needs a bye and therefore an engine rule that is not decided yet.
 */
export const EVEN_ENTRANTS_REQUIRED = true;

export function entrantCountCaveat(entrantCount: number | null): string | null {
  if (entrantCount == null || entrantCount === 0) return null;
  if (!EVEN_ENTRANTS_REQUIRED) return null;
  if (entrantCount % 2 === 0) return null;
  return "An odd number of entrants needs a bye. How a bye counts toward the two placement results is not decided yet.";
}
