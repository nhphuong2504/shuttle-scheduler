/**
 * Knockout draw generation.
 *
 * Draw A = pool winners, B = 2nd, C = 3rd, D = 4th place + any 5th (or lower) finishers.
 * Bracket size rounds up to the next power of 2, byes go to the best seeds
 * (best group-stage point differential first) — never randomly.
 * Invariant: total matches in a single-elimination draw = entrants - 1.
 */

export type DrawTier = "A" | "B" | "C" | "D";
export const DRAW_TIERS: DrawTier[] = ["A", "B", "C", "D"];

export interface Entrant {
  teamId: string;
  /** group-stage point differential, used for seeding */
  diff: number;
  wins: number;
  poolName: string;
  poolRank: number;
}

export interface BracketSlotPair {
  slot: number;
  teamA: string | null;
  teamB: string | null;
  /** true when only one side is filled — the filled side advances automatically */
  isBye: boolean;
}

export function tierForRank(rank: number): DrawTier {
  if (rank === 1) return "A";
  if (rank === 2) return "B";
  if (rank === 3) return "C";
  return "D"; // 4th place plus any 5th (or lower) finishers fold into D
}

export function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return Math.max(size, 2);
}

export function totalMatchesInDraw(entrantCount: number): number {
  return Math.max(entrantCount - 1, 0);
}

/** Standard single-elimination seed order for a bracket of the given size. */
export function seedOrder(size: number): number[] {
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
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.diff !== a.diff) return b.diff - a.diff;
    return a.poolName.localeCompare(b.poolName);
  });
}

/**
 * Builds round 1 only. Round 2+ pairings depend on round 1 results and are
 * never pre-generated beyond one round ahead.
 */
export function buildFirstRound(entrants: Entrant[]): {
  bracketSize: number;
  byes: number;
  pairs: BracketSlotPair[];
  seeded: Entrant[];
} {
  const seeded = seedEntrants(entrants);
  const bracketSize = nextPowerOfTwo(seeded.length);
  const order = seedOrder(bracketSize);
  // seed number (1-based) -> entrant, missing seeds are byes
  const bySeed = new Map<number, Entrant>();
  seeded.forEach((e, i) => bySeed.set(i + 1, e));

  const pairs: BracketSlotPair[] = [];
  for (let i = 0; i < bracketSize; i += 2) {
    const a = bySeed.get(order[i]!) ?? null;
    const b = bySeed.get(order[i + 1]!) ?? null;
    pairs.push({
      slot: i / 2 + 1,
      teamA: a?.teamId ?? null,
      teamB: b?.teamId ?? null,
      isBye: (a === null) !== (b === null),
    });
  }

  return { bracketSize, byes: bracketSize - seeded.length, pairs, seeded };
}

export function roundName(bracketSize: number, round: number): string {
  const teamsLeft = bracketSize / Math.pow(2, round - 1);
  if (teamsLeft === 2) return "Final";
  if (teamsLeft === 4) return "Semifinal";
  if (teamsLeft === 8) return "Quarterfinal";
  return `Round of ${teamsLeft}`;
}
