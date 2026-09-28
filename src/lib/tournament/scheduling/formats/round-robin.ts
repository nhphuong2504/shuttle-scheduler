/**
 * Round-robin format: every entrant plays every other entrant once.
 *
 * Pure structure. Entrant refs are opaque, and the only assumptions are that they are distinct and
 * that a participant appears at most once per round. An odd field is handled with a rotating bye.
 */

import type { FormatMatch, FormatProvider } from "../../../scheduling/providers";

export interface RoundRobinInput {
  /** Entrant refs in seed order. Duplicates are ignored after the first. */
  entrants: readonly string[];
  /** Group key shared by every match of this round robin, e.g. a pool id. */
  groupKey: string;
  timingKey?: string | undefined;
  idPrefix?: string | undefined;
  /** Soft phase, e.g. the pool's index. */
  phase?: number | undefined;
  /** Soft cross-group preference, e.g. the pool's display order. */
  softOrder?: number | undefined;
}

/**
 * The circle method. With an odd field the last slot is a bye and whoever is paired with it sits
 * the round out, so the field still plays `n - 1` rounds.
 */
export function buildRoundRobin(input: RoundRobinInput): FormatMatch[] {
  const entrants = [...new Set(input.entrants)];
  if (entrants.length < 2) return [];

  const prefix = input.idPrefix ?? input.groupKey;
  const rotation = [...entrants];
  if (rotation.length % 2 === 1) rotation.push("");

  const rounds = rotation.length - 1;
  const half = rotation.length / 2;
  const matches: FormatMatch[] = [];

  for (let round = 0; round < rounds; round++) {
    let pairing = 0;
    for (let i = 0; i < half; i++) {
      const home = rotation[i]!;
      const away = rotation[rotation.length - 1 - i]!;
      if (home === "" || away === "") continue;
      matches.push({
        id: `${prefix}-r${round + 1}-m${pairing + 1}`,
        participantRefs: [home, away],
        ...(input.timingKey == null ? {} : { timingKey: input.timingKey }),
        groupKey: input.groupKey,
        completionKey: input.groupKey,
        // One pool runs its own rounds, so a stage is the pool's round. The last round of a pool
        // releases nothing; every earlier one releases the next.
        stageKey: `${input.groupKey}:r${round + 1}`,
        stageUnlocks: round + 1 < rounds,
        phase: input.phase ?? 0,
        sequence: round * 1000 + pairing,
        softOrder: input.softOrder ?? 0,
      });
      pairing++;
    }
    const fixed = rotation[0]!;
    const rest = rotation.slice(1);
    rest.unshift(rest.pop()!);
    rotation.splice(0, rotation.length, fixed, ...rest);
  }

  return matches;
}

export const roundRobinFormat: FormatProvider<RoundRobinInput> = {
  id: "round-robin",
  name: "Round robin",
  timingKeys: [],
  buildMatches: buildRoundRobin,
};
