/**
 * Single-elimination format: standard bracket seeding, byes to the highest seeds.
 *
 * The seeding order is the generic bracket construction, not a sport rule: round one pairs the
 * standard seed order (1 v N, N/2+1 v N/2, ...) so the strongest entrants meet as late as
 * possible. A bye is emitted as a `bye: true` FormatMatch carrying the one entrant who advances;
 * it is never schedulable and is not a match in the scheduling problem.
 */

import type { FormatMatch, FormatProvider } from "../../../scheduling/providers";

export interface SingleEliminationInput {
  /** Entrant refs in seed order (strongest first). */
  entrants: readonly string[];
  groupKey: string;
  timingKey?: string | undefined;
  idPrefix?: string | undefined;
  phase?: number | undefined;
  softOrder?: number | undefined;
  /**
   * When true, emit round one only. Later rounds are created as results arrive, which is how a
   * live draw grows; when false the whole bracket is emitted up front with feeder refs.
   */
  roundOneOnly?: boolean | undefined;
}

/** Standard bracket seed order for a power-of-two size: 1,8,4,5,2,7,3,6 for 8. */
export function standardSeedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    const next: number[] = [];
    for (const seed of order) next.push(seed, sum - seed);
    order = next;
  }
  return order;
}

/** The smallest power of two at or above `value` (1 for 0). */
export function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

export function buildSingleElimination(input: SingleEliminationInput): FormatMatch[] {
  const entrants = [...new Set(input.entrants)];
  if (entrants.length < 2) return [];

  const prefix = input.idPrefix ?? input.groupKey;
  const bracketSize = nextPowerOfTwo(entrants.length);
  const order = standardSeedOrder(bracketSize);
  const byRank = new Map<number, string>();
  entrants.forEach((entrant, index) => byRank.set(index + 1, entrant));

  type Slot = { ref: string | null; feeder: string | null };
  let previous: Slot[] = [];

  // ---- round one ----
  const matches: FormatMatch[] = [];
  for (let i = 0; i < bracketSize / 2; i++) {
    const rankA = order[i * 2];
    const rankB = order[i * 2 + 1];
    if (rankA == null || rankB == null) continue;
    const refA = byRank.get(rankA) ?? null;
    const refB = byRank.get(rankB) ?? null;
    if (refA === null && refB === null) continue;

    const id = `${prefix}-r1-m${i + 1}`;
    const isBye = refA === null || refB === null;
    matches.push({
      id,
      participantRefs: [refA, refB],
      ...(input.timingKey == null ? {} : { timingKey: input.timingKey }),
      groupKey: input.groupKey,
      completionKey: input.groupKey,
      phase: input.phase ?? 0,
      sequence: i,
      softOrder: input.softOrder ?? 0,
      ...(isBye ? { bye: true } : {}),
    });
    previous.push({ ref: null, feeder: id });
  }

  if (input.roundOneOnly) return matches;

  // ---- later rounds ----
  let round = 2;
  while (previous.length > 1) {
    const next: Slot[] = [];
    for (let i = 0; i + 1 < previous.length; i += 2) {
      const first = previous[i]!;
      const second = previous[i + 1]!;
      const id = `${prefix}-r${round}-m${i / 2 + 1}`;
      matches.push({
        id,
        participantRefs: [null, null],
        dependencyRefs: [first.feeder, second.feeder].filter(
          (ref): ref is string => ref != null,
        ),
        ...(input.timingKey == null ? {} : { timingKey: input.timingKey }),
        groupKey: input.groupKey,
        completionKey: input.groupKey,
        phase: input.phase ?? 0,
        sequence: i / 2,
        softOrder: input.softOrder ?? 0,
      });
      next.push({ ref: null, feeder: id });
    }
    previous = next;
    round++;
  }

  return matches;
}

export const singleEliminationFormat: FormatProvider<SingleEliminationInput> = {
  id: "single-elimination",
  name: "Single elimination",
  timingKeys: [],
  buildMatches: buildSingleElimination,
};
