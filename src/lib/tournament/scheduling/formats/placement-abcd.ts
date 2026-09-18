/**
 * A/B/C/D placement format: one independent bracket per tier.
 *
 * The structure is entirely tiers of entrants, so it is generic: each tier becomes a
 * single-elimination bracket with its own group and completion key, and the tier's position becomes
 * the soft order so higher tiers are preferred first.
 */

import type { FormatMatch, FormatProvider } from "../../../scheduling/providers";
import { buildSingleElimination } from "./single-elimination";

export interface PlacementTierInput {
  /** Opaque tier id, e.g. "A". Tiers are ordered as given. */
  tier: string;
  /** Entrant refs in seed order. */
  entrants: readonly string[];
}

export interface PlacementAbcdInput {
  tiers: readonly PlacementTierInput[];
  timingKey?: string | undefined;
  idPrefix?: string | undefined;
  /** Phase of the first tier; each later tier is one higher. */
  phaseBase?: number | undefined;
  /**
   * Legacy behavior: only round one is built, and later rounds are created as results arrive.
   * Defaults to true.
   */
  roundOneOnly?: boolean | undefined;
}

export function buildPlacementAbcd(input: PlacementAbcdInput): FormatMatch[] {
  const prefix = input.idPrefix ?? "placement";
  const matches: FormatMatch[] = [];
  input.tiers.forEach((tier, index) => {
    matches.push(
      ...buildSingleElimination({
        entrants: tier.entrants,
        groupKey: tier.tier,
        idPrefix: `${prefix}-${tier.tier}`,
        phase: (input.phaseBase ?? 0) + index,
        softOrder: index,
        ...(input.timingKey == null ? {} : { timingKey: input.timingKey }),
        roundOneOnly: input.roundOneOnly ?? true,
      }),
    );
  });
  return matches;
}

export const placementAbcdFormat: FormatProvider<PlacementAbcdInput> = {
  id: "placement-abcd",
  name: "A/B/C/D placement",
  timingKeys: [],
  buildMatches: buildPlacementAbcd,
};
