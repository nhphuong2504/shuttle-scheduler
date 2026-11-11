/**
 * Knockout draw generation.
 *
 * Draw A = pool winners, B = 2nd, C = 3rd, D = 4th place + any 5th finishers.
 * Byes go to the best group-stage point differential.
 */

import type { DrawTier } from "./competition-format";

export type { DrawTier };
export const DRAW_TIERS: DrawTier[] = ["A", "B", "C", "D"];

export interface Entrant {
  teamId: string;
  diff: number;
  wins: number;
  poolName: string;
  poolRank: number;
}

export interface BracketSlotPair {
  slot: number;
  teamA: string | null;
  teamB: string | null;
  isBye: boolean;
}

export function tierForRank(rank: number): DrawTier {
  if (rank === 1) return "A";
  if (rank === 2) return "B";
  if (rank === 3) return "C";
  return "D";
}

export function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

export function totalMatchesInDraw(entrantCount: number): number {
  return Math.max(entrantCount - 1, 0);
}

export function playableMatchesInFirstRound(pairs: BracketSlotPair[]): number {
  return pairs.filter((p) => !p.isBye).length;
}

export function seedOrder(size: number): number[] {
  if (size <= 1) return [1];
  let order = [1, 2];
  while (order.length < size) {
    const round = order.length * 2;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed, round + 1 - seed);
    }
    order = next;
  }
  return order;
}

export function seedEntrants(entrants: Entrant[]): Entrant[] {
  return [...entrants].sort((a, b) => {
    if (b.diff !== a.diff) return b.diff - a.diff;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.poolName.localeCompare(b.poolName) || a.teamId.localeCompare(b.teamId);
  });
}

function wouldRematch(a: Entrant | null, b: Entrant | null): boolean {
  return !!a && !!b && a.poolName === b.poolName;
}

export function buildFirstRound(entrants: Entrant[]): {
  bracketSize: number;
  byes: number;
  pairs: BracketSlotPair[];
  seeded: Entrant[];
} {
  const seeded = seedEntrants(entrants);
  const bracketSize = nextPowerOfTwo(Math.max(seeded.length, 1));
  const order = seedOrder(bracketSize);
  const bySeed = new Map<number, Entrant>();
  seeded.forEach((e, i) => bySeed.set(i + 1, e));

  if (seeded.length >= 4) {
    for (let i = 0; i < bracketSize; i += 2) {
      const seedA = order[i]!;
      const seedB = order[i + 1]!;
      const a = bySeed.get(seedA) ?? null;
      const b = bySeed.get(seedB) ?? null;
      if (!wouldRematch(a, b)) continue;
      for (let j = i + 2; j < bracketSize; j += 2) {
        const altB = bySeed.get(order[j + 1]!) ?? null;
        if (altB && !wouldRematch(a, altB) && !wouldRematch(bySeed.get(order[j]!) ?? null, b)) {
          const tmp = bySeed.get(seedB);
          if (tmp) bySeed.set(seedB, altB);
          if (altB) bySeed.set(order[j + 1]!, tmp ?? altB);
          break;
        }
      }
    }
  }

  const pairs: BracketSlotPair[] = [];
  for (let i = 0; i < bracketSize; i += 2) {
    const a = bySeed.get(order[i]!) ?? null;
    const b = bySeed.get(order[i + 1]!) ?? null;
    pairs.push({
      slot: i / 2 + 1,
      teamA: a?.teamId ?? null,
      teamB: b?.teamId ?? null,
      isBye: (a === null) !== (b === null) || (a !== null && b === null) || (a === null && b !== null),
    });
  }

  return { bracketSize, byes: Math.max(bracketSize - seeded.length, 0), pairs, seeded };
}

/**
 * The label for one round of a knockout bracket.
 *
 * The single source of truth for round naming, shared by both formats: the pooled
 * draws view and the placement format's A/B/C/D tier draws. It used to exist twice,
 * spelled differently in each place — "Semifinal" here and "Semi-final" in the
 * Knockout tab — so the same round of the same kind of bracket read two ways
 * depending on which screen you were on.
 *
 * The round is derived from the bracket size rather than from how many rounds the
 * draw currently has matches for, which matters because later rounds are created
 * only once the round before them is decided. Counting the rounds present would
 * label the opening round of a half-played 16-draw "Final", since one round is all
 * there is at that point.
 *
 * `teamsLeft` falls by half each round, so it names the round the way a bracket is
 * usually read: 32 left is the round of 32, down to 2 for the final.
 */
export function roundName(bracketSize: number, round: number): string {
  const teamsLeft = bracketSize / Math.pow(2, round - 1);
  if (teamsLeft === 1) return "Champion";
  if (teamsLeft === 2) return "Final";
  if (teamsLeft === 4) return "Semifinal";
  if (teamsLeft === 8) return "Quarterfinal";
  return `Round of ${teamsLeft}`;
}
