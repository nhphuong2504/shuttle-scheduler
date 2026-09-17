/**
 * Two-round placement stage: pairing, make-up matches, crossover and tiers.
 *
 * The format in one line: every entrant plays two placement matches, and the two
 * results sort them into one of four single-elimination draws.
 *
 *   WW -> Draw A   WL -> Draw B   LW -> Draw C   LL -> Draw D
 *
 * Two rules shape everything below:
 *
 * 1. NO BYES. An odd entry count "holds" one entrant out of round one, and that
 *    entrant then plays two make-up matches in round two. Every entrant finishes
 *    with exactly two decided matches, so nobody ever reaches a draw with an
 *    incomplete record. Holding an entrant is deliberately expressed as an
 *    absence of a row rather than a "bye" row, which is what makes it neutral:
 *    there is nothing to accidentally count as a win or a loss.
 *
 * 2. HALF-SPLIT PAIRING, not standard bracket seeding. Seeds are paired
 *    `i` vs `ceil(N/2)+i`, which mixes the skill blocks at their boundary instead
 *    of always pitting the strongest against the weakest. With skill-based
 *    seeding, standard pairing would make round one predictable and therefore
 *    uninformative.
 *
 * This module is pure: it takes entrants and results, and returns the matches to
 * create. It performs no I/O, so the algorithm is directly testable.
 */

import { tierForRecord, type DrawTier, type PlacementRecord } from "./competition-format";

export type PlacementStage = "round1" | "round2";

/**
 * The number of placement matches an entrant must complete before a draw can be
 * generated. `N <= 2` cannot produce two matches at all, so the requirement is
 * lowered explicitly rather than silently leaving those draws blocked forever.
 */
export function requiredPlacementMatches(entrantCount: number): number {
  if (entrantCount <= 1) return 0;
  if (entrantCount === 2) return 1;
  return 2;
}

/** N = 1: no matches are played, so the sole entrant simply takes Draw A. */
export const SOLO_ENTRANT_TIER: DrawTier = "A";

/**
 * N = 2: one match is played and then the stage stops. Crossover is deliberately
 * NOT applied, because the only leftover winner and leftover loser would be the
 * two people who just played each other. The winner takes Draw A, the loser D.
 */
export const TWO_ENTRANT_TIERS: { winner: DrawTier; loser: DrawTier } = {
  winner: "A",
  loser: "D",
};

/**
 * Default cap on how many other round-two matches must finish between the held
 * entrant's two make-up matches. Scaling the gap with the field size is what
 * keeps the rule usable at small N, where there are barely enough matches to
 * interleave at all; the time-based rest gap still applies on top.
 */
export const DEFAULT_MAX_INTERLEAVE = 3;

export function heldEntrantInterleaveCount(
  entrantCount: number,
  max: number = DEFAULT_MAX_INTERLEAVE,
): number {
  if (entrantCount < 3) return 0;
  return Math.max(0, Math.min(max, Math.floor((entrantCount - 3) / 2)));
}

export interface PlacementEntrantRef {
  id: string;
  /** 1..N, assigned once by skill block. */
  seed: number;
}

export interface GeneratedPlacementMatch {
  /** Stable local key, unique within the stage. */
  key: string;
  stage: PlacementStage;
  entrantAId: string;
  entrantBId: string;
  /** True for the held entrant's two make-up matches. */
  isMakeup: boolean;
  /** True for the leftover-winner vs leftover-loser match. */
  isCrossover: boolean;
  /**
   * Keys of matches that must finish before this one may start. Only the held
   * entrant's second make-up match uses this today.
   */
  prerequisiteKeys: string[];
}

export interface RoundOnePlan {
  matches: GeneratedPlacementMatch[];
  /** The entrant held out of round one when the entry count is odd. */
  heldEntrantId: string | null;
  entrantCount: number;
}

/** Unordered pair key, so `a vs b` and `b vs a` collapse to one entry. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function bySeed(entrants: readonly PlacementEntrantRef[]): PlacementEntrantRef[] {
  return [...entrants].sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
}

/**
 * Half-split pairing over an already seed-ordered list.
 *
 * Pairs position `i` with position `ceil(m/2)+i`, and leaves the middle element
 * over when `m` is odd. The leftover is always the middle seed, which is worth
 * knowing: it means "which entrant is held" is a property of the seed order, not
 * an arbitrary choice.
 */
export function halfSplitPairing(sorted: readonly PlacementEntrantRef[]): {
  pairs: [PlacementEntrantRef, PlacementEntrantRef][];
  leftover: PlacementEntrantRef | null;
} {
  const m = sorted.length;
  const half = Math.ceil(m / 2);
  const pairs: [PlacementEntrantRef, PlacementEntrantRef][] = [];
  for (let i = 0; i < Math.floor(m / 2); i++) {
    pairs.push([sorted[i] as PlacementEntrantRef, sorted[half + i] as PlacementEntrantRef]);
  }
  const leftover = m % 2 === 1 ? (sorted[half - 1] as PlacementEntrantRef) : null;
  return { pairs, leftover };
}

/**
 * Round one: seeds split in half and paired across the split.
 *
 * For odd `N` the middle seed is held and no row is produced for them at all.
 * `N = 1` falls out of the same arithmetic: no pairs, and the sole entrant held.
 */
export function pairPlacementRoundOne(entrants: readonly PlacementEntrantRef[]): RoundOnePlan {
  const sorted = bySeed(entrants);
  const { pairs, leftover } = halfSplitPairing(sorted);

  return {
    matches: pairs.map((pair, index) => ({
      key: `r1-${index + 1}`,
      stage: "round1" as const,
      entrantAId: pair[0].id,
      entrantBId: pair[1].id,
      isMakeup: false,
      isCrossover: false,
      prerequisiteKeys: [],
    })),
    heldEntrantId: leftover?.id ?? null,
    entrantCount: sorted.length,
  };
}

export interface RoundTwoInput {
  entrants: readonly PlacementEntrantRef[];
  roundOne: readonly GeneratedPlacementMatch[];
  /** Round-one match key -> winning entrant id, or null while undecided. */
  roundOneWinners: ReadonlyMap<string, string | null>;
  heldEntrantId: string | null;
  /**
   * How many other round-two matches must finish before the held entrant's
   * second make-up match. Defaults to the size-scaled value.
   */
  interleaveCount?: number | undefined;
}

export interface RoundTwoPlan {
  matches: GeneratedPlacementMatch[];
  /** True when this plan used the crossover mechanism. */
  usedCrossover: boolean;
}

export class PlacementRoundTwoError extends Error {}

/**
 * Round two, built from round-one results.
 *
 * The steps, in order:
 *
 * 1. If an entrant was held, they play the seed-nearest member of the winners,
 *    then the seed-nearest member of the losers. Ties go to the weaker (higher)
 *    seed, so an opponent who just beat a strong seed is not punished twice.
 * 2. The remaining winners pair among themselves, and the remaining losers
 *    among themselves.
 * 3. If exactly one winner and one loser are left, they play the crossover.
 *
 * Crossover is required exactly when `N mod 4` is 1 or 2. That follows from the
 * parity of the sections once the held entrant's two opponents are removed: each
 * section holds `(N-3)/2` entrants for odd `N`, and `N/2` for even `N`.
 *
 * Internal pairings can never be rematches, because a round-one match puts its
 * winner in `W` and its loser in `L`, so the two members of any round-one pair
 * are always in different sections. Only the crossover can replay a round-one
 * match, and step 3 avoids it by choosing which two entrants are left over.
 */
export function buildPlacementRoundTwo(input: RoundTwoInput): RoundTwoPlan {
  const { entrants, roundOne, roundOneWinners, heldEntrantId } = input;
  const seedById = new Map(entrants.map((entrant) => [entrant.id, entrant.seed]));

  const winners: PlacementEntrantRef[] = [];
  const losers: PlacementEntrantRef[] = [];
  const roundOnePairs = new Set<string>();

  for (const match of roundOne) {
    const winnerId = roundOneWinners.get(match.key);
    if (winnerId == null) {
      throw new PlacementRoundTwoError(
        `Round two cannot be built while ${match.key} is undecided.`,
      );
    }
    const a = { id: match.entrantAId, seed: seedById.get(match.entrantAId) ?? 0 };
    const b = { id: match.entrantBId, seed: seedById.get(match.entrantBId) ?? 0 };
    roundOnePairs.add(pairKey(a.id, b.id));

    if (winnerId === a.id) {
      winners.push(a);
      losers.push(b);
    } else if (winnerId === b.id) {
      winners.push(b);
      losers.push(a);
    } else {
      throw new PlacementRoundTwoError(
        `${match.key} names winner ${winnerId}, who is not one of its entrants.`,
      );
    }
  }

  const matches: GeneratedPlacementMatch[] = [];

  // Step 1: the held entrant's two make-up matches, chosen before anyone else is
  // paired, because their opponents have to leave their sections first.
  const heldMatches: GeneratedPlacementMatch[] = [];
  if (heldEntrantId != null) {
    const heldSeed = seedById.get(heldEntrantId);
    if (heldSeed == null) {
      throw new PlacementRoundTwoError(`Held entrant ${heldEntrantId} is not in this category.`);
    }
    winners.sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
    losers.sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));

    const winnerOpponent = takeNearestSeed(winners, heldSeed);
    const loserOpponent = takeNearestSeed(losers, heldSeed);
    if (!winnerOpponent || !loserOpponent) {
      throw new PlacementRoundTwoError(
        "A held entrant needs at least one winner and one loser to play.",
      );
    }

    heldMatches.push({
      key: "r2-makeup-1",
      stage: "round2",
      entrantAId: heldEntrantId,
      entrantBId: winnerOpponent.id,
      isMakeup: true,
      isCrossover: false,
      prerequisiteKeys: [],
    });
    heldMatches.push({
      key: "r2-makeup-2",
      stage: "round2",
      entrantAId: heldEntrantId,
      entrantBId: loserOpponent.id,
      isMakeup: true,
      isCrossover: false,
      // Filled in below, once every round-two key is known.
      prerequisiteKeys: ["r2-makeup-1"],
    });
  }

  // Steps 2 and 3: pair within each section, then cross over any two leftovers.
  let pairWinners = halfSplitPairing(winners);
  let pairLosers = halfSplitPairing(losers);
  let crossover: [PlacementEntrantRef, PlacementEntrantRef] | null = null;

  if (pairWinners.leftover && pairLosers.leftover) {
    const chosen = chooseCrossover(
      winners,
      losers,
      pairWinners.leftover,
      pairLosers.leftover,
      roundOnePairs,
    );
    crossover = chosen.crossover;
    pairWinners = chosen.winners;
    pairLosers = chosen.losers;
  }

  // The held entrant's matches come first, so a reader sees the make-up pair
  // together and the rest of the round follows.
  matches.push(...heldMatches);

  let index = 0;
  for (const pair of pairWinners.pairs) {
    matches.push({
      key: `r2-${++index}`,
      stage: "round2",
      entrantAId: pair[0].id,
      entrantBId: pair[1].id,
      isMakeup: false,
      isCrossover: false,
      prerequisiteKeys: [],
    });
  }
  for (const pair of pairLosers.pairs) {
    matches.push({
      key: `r2-${++index}`,
      stage: "round2",
      entrantAId: pair[0].id,
      entrantBId: pair[1].id,
      isMakeup: false,
      isCrossover: false,
      prerequisiteKeys: [],
    });
  }
  if (crossover) {
    matches.push({
      key: `r2-${++index}`,
      stage: "round2",
      entrantAId: crossover[0].id,
      entrantBId: crossover[1].id,
      isMakeup: false,
      isCrossover: true,
      prerequisiteKeys: [],
    });
  }

  // The held entrant's second match waits for their first match plus `k` other
  // round-two matches, so `k` matches are guaranteed to complete in between.
  // Time-based rest is enforced separately by the scheduler.
  const interleave = input.interleaveCount ?? heldEntrantInterleaveCount(entrants.length);
  const second = matches.find((match) => match.key === "r2-makeup-2");
  if (second && interleave > 0) {
    const candidates = matches
      .filter((match) => match.key !== "r2-makeup-1" && match.key !== "r2-makeup-2")
      .map((match) => match.key)
      .sort((a, b) => a.localeCompare(b));
    second.prerequisiteKeys = ["r2-makeup-1", ...candidates.slice(0, interleave)];
  }

  return { matches, usedCrossover: crossover != null };
}

/**
 * Removes and returns the member of `pool` whose seed is closest to `targetSeed`.
 * A tie goes to the weaker (higher) seed, so the stronger entrant is not handed
 * an extra hard match.
 */
function takeNearestSeed(
  pool: PlacementEntrantRef[],
  targetSeed: number,
): PlacementEntrantRef | null {
  if (!pool.length) return null;
  let bestIndex = 0;
  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[i] as PlacementEntrantRef;
    const best = pool[bestIndex] as PlacementEntrantRef;
    const candidateDistance = Math.abs(candidate.seed - targetSeed);
    const bestDistance = Math.abs(best.seed - targetSeed);
    if (
      candidateDistance < bestDistance ||
      (candidateDistance === bestDistance && candidate.seed > best.seed)
    ) {
      bestIndex = i;
    }
  }
  return pool.splice(bestIndex, 1)[0] as PlacementEntrantRef;
}

/**
 * Chooses which two leftovers play the crossover, preferring the natural
 * half-split leftovers but stepping aside when they would replay a round-one
 * match.
 *
 * There is always a safe choice when a crossover is needed: a leftover winner is
 * a round-one opponent of exactly one leftover loser, so with at least two
 * candidates on either side at least one combination is safe. `N = 2` is the
 * only field where no safe choice exists, and that case is excluded before this
 * is reached.
 */
function chooseCrossover(
  winners: readonly PlacementEntrantRef[],
  losers: readonly PlacementEntrantRef[],
  naturalWinner: PlacementEntrantRef,
  naturalLoser: PlacementEntrantRef,
  roundOnePairs: ReadonlySet<string>,
): {
  crossover: [PlacementEntrantRef, PlacementEntrantRef];
  winners: {
    pairs: [PlacementEntrantRef, PlacementEntrantRef][];
    leftover: PlacementEntrantRef | null;
  };
  losers: {
    pairs: [PlacementEntrantRef, PlacementEntrantRef][];
    leftover: PlacementEntrantRef | null;
  };
} {
  const winnerCandidates = preferredOrder(winners, naturalWinner);
  const loserCandidates = preferredOrder(losers, naturalLoser);

  for (const winner of winnerCandidates) {
    for (const loser of loserCandidates) {
      if (roundOnePairs.has(pairKey(winner.id, loser.id))) continue;
      return {
        crossover: [winner, loser],
        winners: halfSplitPairing(winners.filter((entry) => entry.id !== winner.id)),
        losers: halfSplitPairing(losers.filter((entry) => entry.id !== loser.id)),
      };
    }
  }

  // Unreachable for N >= 3, but falling back to the natural leftovers keeps this
  // total rather than throwing, and the pairing stays legal even if it repeats.
  return {
    crossover: [naturalWinner, naturalLoser],
    winners: halfSplitPairing(winners.filter((entry) => entry.id !== naturalWinner.id)),
    losers: halfSplitPairing(losers.filter((entry) => entry.id !== naturalLoser.id)),
  };
}

/** The natural leftover first, then the rest in seed order. */
function preferredOrder(
  pool: readonly PlacementEntrantRef[],
  natural: PlacementEntrantRef,
): PlacementEntrantRef[] {
  const rest = pool
    .filter((entry) => entry.id !== natural.id)
    .sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
  return [natural, ...rest];
}

/** WW / WL / LW / LL from the two round results. */
export function recordForResults(round1Won: boolean, round2Won: boolean): PlacementRecord {
  if (round1Won) return round2Won ? "WW" : "WL";
  return round2Won ? "LW" : "LL";
}

export interface EntrantPlacementOutcome {
  entrantId: string;
  seed: number;
  played: number;
  wins: number;
  losses: number;
  /**
   * The entrant's two placement results, in play order. For a regular entrant
   * that is their round-one match followed by their round-two match. For the
   * held entrant it is their two make-up matches, which both sit in round two —
   * so these are deliberately not named after rounds.
   */
  firstWon: boolean | null;
  secondWon: boolean | null;
  /** True when this entrant was held out of round one and played two make-ups. */
  isHeld: boolean;
  /**
   * Null until both results are decided. Always null for fields of one or two,
   * which cannot produce a full two-match record.
   */
  record: PlacementRecord | null;
  tier: DrawTier | null;
}

export interface PlacementOutcomeInput {
  entrants: readonly PlacementEntrantRef[];
  matches: readonly GeneratedPlacementMatch[];
  /** match key -> winning entrant id, or null while undecided. */
  winners: ReadonlyMap<string, string | null>;
}

/**
 * Play order for one entrant's matches.
 *
 * Round one always comes first. Within round two the make-up matches come before
 * the rest, because the held entrant plays those two and nothing else, and their
 * record is read in that order. No other entrant has two matches in the same
 * stage, so no further tie-breaking is needed.
 */
function matchSequenceRank(match: GeneratedPlacementMatch): number {
  if (match.stage === "round1") return 0;
  if (match.key === "r2-makeup-1") return 1;
  if (match.key === "r2-makeup-2") return 2;
  return 3;
}

/**
 * Derives every entrant's record and tier. This is the single source of truth for
 * tier assignment, so the small-field rules live here as explicit branches rather
 * than emerging by accident from the general formula.
 */
export function computePlacementOutcomes(input: PlacementOutcomeInput): EntrantPlacementOutcome[] {
  const { entrants, matches, winners } = input;
  const fieldSize = entrants.length;

  const byEntrant = new Map<string, GeneratedPlacementMatch[]>();
  for (const match of matches) {
    for (const id of [match.entrantAId, match.entrantBId]) {
      const list = byEntrant.get(id) ?? [];
      list.push(match);
      byEntrant.set(id, list);
    }
  }

  const outcomes: EntrantPlacementOutcome[] = [];
  for (const entrant of entrants) {
    const theirs = [...(byEntrant.get(entrant.id) ?? [])].sort(
      (a, b) => matchSequenceRank(a) - matchSequenceRank(b),
    );
    const firstWon = decidedWin(theirs[0], entrant.id, winners);
    const secondWon = decidedWin(theirs[1], entrant.id, winners);

    const results = [firstWon, secondWon];
    const wins = results.filter((won) => won === true).length;
    const played = results.filter((won) => won !== null).length;
    // The held entrant is the only one whose matches are all in round two.
    const isHeld = theirs.length > 0 && theirs.every((match) => match.stage === "round2");

    let record: PlacementRecord | null = null;
    let tier: DrawTier | null = null;

    if (fieldSize === 1) {
      // No matches are played at all: the sole entrant is the champion of Draw A.
      tier = SOLO_ENTRANT_TIER;
    } else if (fieldSize === 2) {
      // One match, then stop. No crossover, because it would replay that match.
      // The winner takes Draw A and the loser Draw D.
      if (firstWon !== null) {
        tier = firstWon ? TWO_ENTRANT_TIERS.winner : TWO_ENTRANT_TIERS.loser;
      }
    } else if (firstWon !== null && secondWon !== null) {
      record = recordForResults(firstWon, secondWon);
      tier = tierForRecord(record);
    }

    outcomes.push({
      entrantId: entrant.id,
      seed: entrant.seed,
      played,
      wins,
      losses: played - wins,
      firstWon,
      secondWon,
      isHeld,
      record,
      tier,
    });
  }

  return outcomes;
}

function decidedWin(
  match: GeneratedPlacementMatch | undefined,
  entrantId: string,
  winners: ReadonlyMap<string, string | null>,
): boolean | null {
  if (!match) return null;
  const winnerId = winners.get(match.key);
  if (winnerId == null) return null;
  return winnerId === entrantId;
}

export interface PlacementGateEntrant extends PlacementEntrantRef {
  /** Waived by the desk, so the gate ignores them. */
  excluded?: boolean | undefined;
}

export interface PlacementGate {
  ready: boolean;
  /** Entrants still short of the required number of decided matches. */
  short: { entrantId: string; played: number; required: number }[];
  /** Entrants the gate actually considered. */
  counted: number;
  excluded: number;
  requiredMatches: number;
}

/**
 * Whether draws may be generated. Every active entrant must have completed their
 * required placement matches; a waived entrant is skipped rather than blocking
 * the whole category, which matters because a single void would otherwise stall
 * everything behind it.
 *
 * The field size that decides `required` counts only the entrants who are
 * actually playing. Including waived entrants would change the requirement: two
 * active entrants plus one waived is still a field of two, which needs one match,
 * not two. This mirrors `placement_required_matches` in SQL, which filters on
 * `NOT excluded` for the same reason.
 */
export function placementGate(
  entrants: readonly PlacementGateEntrant[],
  outcomes: readonly EntrantPlacementOutcome[],
): PlacementGate {
  const playing = entrants.filter((entrant) => !entrant.excluded);
  const required = requiredPlacementMatches(playing.length);
  const playedById = new Map(outcomes.map((outcome) => [outcome.entrantId, outcome.played]));

  const short: { entrantId: string; played: number; required: number }[] = [];
  let counted = 0;
  let excluded = 0;

  for (const entrant of entrants) {
    if (entrant.excluded) {
      excluded++;
      continue;
    }
    counted++;
    const played = playedById.get(entrant.id) ?? 0;
    if (played < required) short.push({ entrantId: entrant.id, played, required });
  }

  return {
    ready: short.length === 0,
    short,
    counted,
    excluded,
    requiredMatches: required,
  };
}

/**
 * Entrants grouped by tier, ready for draw generation. Entrants with no tier yet
 * (an undecided stage, or a waived entrant) are reported separately so the caller
 * can surface them rather than silently dropping them.
 */
export function groupByTier(outcomes: readonly EntrantPlacementOutcome[]): {
  tiers: Record<DrawTier, EntrantPlacementOutcome[]>;
  unassigned: EntrantPlacementOutcome[];
} {
  const tiers: Record<DrawTier, EntrantPlacementOutcome[]> = { A: [], B: [], C: [], D: [] };
  const unassigned: EntrantPlacementOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.tier) tiers[outcome.tier].push(outcome);
    else unassigned.push(outcome);
  }
  for (const tier of ["A", "B", "C", "D"] as DrawTier[]) {
    tiers[tier].sort((a, b) => a.seed - b.seed);
  }
  return { tiers, unassigned };
}
