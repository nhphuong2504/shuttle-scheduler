/**
 * Tier knockouts: the A/B/C/D single-elimination draws.
 *
 * Each tier is an independent bracket. Seeding reuses the entrant's ORIGINAL
 * placement seed, never a fresh shuffle, so "seed" means the same thing for the
 * whole tournament and a player's path is explainable end to end.
 *
 * The bye rule here is the exact opposite of the placement stage, which is the
 * single easiest thing to get confused about:
 *
 *   * Placement stage: NO byes. An odd entry count is handled by holding one
 *     entrant, who then plays two make-up matches.
 *   * Knockout stage: byes ARE allowed, and go to the highest seed.
 *
 * That is not an inconsistency; the stages have different jobs. Placement must
 * give everyone two matches so every record is comparable, while a knockout just
 * needs to eliminate people, and standard seeding absorbs an awkward bracket size
 * by rewarding the strongest entrants.
 *
 * A tier can also arrive with zero or one entrant, because tier sizes follow the
 * entry count and are not balanced. One entrant is the champion immediately, with
 * no bracket at all.
 */

import { DRAW_TIERS, nextPowerOfTwo, seedOrder, type DrawTier } from "./draws";

export interface TierEntrantRef {
  id: string;
  /** The original placement seed. Never reassigned for this stage. */
  seed: number;
}

export interface TierBracketMatch {
  round: number;
  slot: number;
  entrantAId: string | null;
  entrantBId: string | null;
  /** Pre-decided for a bye; otherwise null until reported. */
  winnerId: string | null;
  isBye: boolean;
}

export interface TierBracketPlan {
  tier: DrawTier;
  entrantCount: number;
  /** 0 for an empty tier, 1 for a champion-only tier, else a power of two. */
  bracketSize: number;
  byes: number;
  /** Non-null only for a tier with exactly one entrant. */
  championId: string | null;
  /** Round one only. Later rounds are created as results come in. */
  matches: TierBracketMatch[];
}

/** True when a tier needs no bracket at all: nobody, or a lone champion. */
export function tierNeedsNoBracket(entrantCount: number): boolean {
  return entrantCount <= 1;
}

/**
 * Builds round one of one tier's bracket.
 *
 * Byes fall out of the standard seed order rather than being assigned by a
 * separate rule: the bracket is rounded up to a power of two, and the missing
 * high ranks are simply absent, so the strongest seeds are the ones left without
 * an opponent. That is what "byes go to the highest seed" means in practice.
 */
export function buildTierBracket(
  tier: DrawTier,
  entrants: readonly TierEntrantRef[],
): TierBracketPlan {
  const ordered = [...entrants].sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
  const entrantCount = ordered.length;

  if (entrantCount === 0) {
    return {
      tier,
      entrantCount: 0,
      bracketSize: 0,
      byes: 0,
      championId: null,
      matches: [],
    };
  }

  if (entrantCount === 1) {
    return {
      tier,
      entrantCount: 1,
      bracketSize: 1,
      byes: 0,
      championId: (ordered[0] as TierEntrantRef).id,
      matches: [],
    };
  }

  const bracketSize = nextPowerOfTwo(entrantCount);
  const order = seedOrder(bracketSize);

  // Rank is the position in seed order, which is what `seedOrder` indexes.
  const byRank = new Map<number, TierEntrantRef>();
  ordered.forEach((entrant, index) => byRank.set(index + 1, entrant));

  const matches: TierBracketMatch[] = [];
  for (let i = 0; i < bracketSize / 2; i++) {
    const rankA = order[i * 2];
    const rankB = order[i * 2 + 1];
    if (rankA == null || rankB == null) continue;

    const entrantA = byRank.get(rankA) ?? null;
    const entrantB = byRank.get(rankB) ?? null;

    // Only one side missing is a bye. Two missing ranks cannot happen for a field
    // larger than half the bracket, which `nextPowerOfTwo` guarantees, but the
    // check keeps this total rather than creating an unplayable empty slot.
    if (entrantA === null && entrantB === null) continue;
    const isBye = entrantA === null || entrantB === null;

    matches.push({
      round: 1,
      slot: i + 1,
      entrantAId: entrantA?.id ?? null,
      entrantBId: entrantB?.id ?? null,
      winnerId: isBye ? ((entrantA ?? entrantB) as TierEntrantRef).id : null,
      isBye,
    });
  }

  return {
    tier,
    entrantCount,
    bracketSize,
    byes: bracketSize - entrantCount,
    championId: null,
    matches,
  };
}

export interface DecidedTierMatch {
  slot: number;
  winnerId: string | null;
}

/**
 * Pairs adjacent slots of a finished round into the next round.
 *
 * A bye already carries its winner, so a round containing byes can be complete
 * without anyone having played. Mirrored by `advance_tier_draw_locked` in SQL.
 */
export function nextTierRound(
  previous: readonly DecidedTierMatch[],
  round: number,
): TierBracketMatch[] {
  const sorted = [...previous].sort((a, b) => a.slot - b.slot);
  const matches: TierBracketMatch[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const first = sorted[i] as DecidedTierMatch;
    const second = sorted[i + 1] as DecidedTierMatch;
    matches.push({
      round,
      slot: i / 2 + 1,
      entrantAId: first.winnerId,
      entrantBId: second.winnerId,
      winnerId: null,
      isBye: false,
    });
  }
  return matches;
}

/** True once every slot in a round has a decided winner, so the next round is due. */
export function tierRoundComplete(round: readonly DecidedTierMatch[]): boolean {
  return round.length > 1 && round.every((match) => match.winnerId != null);
}

/**
 * How many rounds a bracket of this size plays, or 0 for a champion-only draw.
 *
 * The depth of a draw is a property of its size alone, so it belongs here beside the
 * bracket builder that produced the size. Progress views need it to tell a final round
 * from an intermediate one; they must not re-derive it, or "is there another round after
 * this one?" would drift from what `nextTierRound` actually produces.
 */
export function bracketRoundCount(bracketSize: number): number {
  if (bracketSize <= 1) return 0;
  return Math.round(Math.log2(bracketSize));
}

/** Tiers in presentation order. */
export const TIER_ORDER: readonly DrawTier[] = DRAW_TIERS;
