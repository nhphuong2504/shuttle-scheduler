/**
 * Pool sizing + round-robin generation.
 *
 * Hard rule: never generate a pool of 3 (it only guarantees 2 matches per entrant).
 * Preferred size is 4, with 5 used only where needed to make the entry count work.
 */

export function planPoolSizes(entrantCount: number): number[] {
  const n = entrantCount;
  if (n < 4) {
    throw new Error("A category needs at least 4 entries to form a pool.");
  }

  // Solve 4a + 5b = n, maximising pools of 4.
  for (let fives = 0; fives * 5 <= n; fives++) {
    const remainder = n - fives * 5;
    if (remainder % 4 === 0) {
      const fours = remainder / 4;
      return [...Array<number>(fours).fill(4), ...Array<number>(fives).fill(5)].sort((a, b) => b - a);
    }
  }

  // n = 6, 7 or 11 cannot be split into 4s and 5s without creating a pool of 3.
  // Fall back to a single oversized pool (or 6 + 5 for 11) rather than breaking the rule.
  if (n === 11) return [6, 5];
  return [n];
}

export function splitIntoPools<T>(entrants: T[]): T[][] {
  const sizes = planPoolSizes(entrants.length);
  const pools: T[][] = sizes.map(() => []);
  // Snake distribution keeps strength spread across pools.
  let index = 0;
  let direction = 1;
  for (const entrant of entrants) {
    pools[index].push(entrant);
    if (pools[index].length > sizes[index]) {
      // shouldn't happen, but guard against overflow
      pools[index].pop();
    }
    // advance to next pool that still has room
    let guard = 0;
    do {
      index += direction;
      if (index >= pools.length) {
        index = pools.length - 1;
        direction = -1;
      } else if (index < 0) {
        index = 0;
        direction = 1;
      }
      guard++;
    } while (pools[index].length >= sizes[index] && guard <= pools.length * 2);
  }
  return pools;
}

export interface RoundRobinPairing<T> {
  round: number;
  teamA: T;
  teamB: T;
}

/**
 * Standard circle method. Within a pool, no entrant appears twice in the same round.
 */
export function circleMethod<T>(entrants: T[]): RoundRobinPairing<T>[] {
  const list: (T | null)[] = [...entrants];
  if (list.length % 2 === 1) list.push(null);

  const half = list.length / 2;
  const rotation = list.slice();
  const pairings: RoundRobinPairing<T>[] = [];

  for (let round = 1; round <= list.length - 1; round++) {
    for (let i = 0; i < half; i++) {
      const a = rotation[i];
      const b = rotation[rotation.length - 1 - i];
      if (a !== null && b !== null) {
        pairings.push({ round, teamA: a, teamB: b });
      }
    }
    // rotate everything except the first element
    const fixed = rotation[0];
    const rest = rotation.slice(1);
    rest.unshift(rest.pop() as T | null);
    rotation.length = 0;
    rotation.push(fixed, ...rest);
  }

  return pairings;
}

export function poolMatchCount(size: number): number {
  return (size * (size - 1)) / 2;
}
