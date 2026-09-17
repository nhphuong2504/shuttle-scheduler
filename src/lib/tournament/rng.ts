/**
 * A deterministic pseudo-random number generator.
 *
 * Seeding is a one-shot, auditable decision: the shuffle that orders entrants
 * inside a skill block has to be reproducible, so that re-running generation for
 * the same tournament produces the same seeds and nobody has to wonder whether
 * the draw was quietly re-rolled. A seeded generator is what makes that possible.
 *
 * This is the same algorithm the day-one scheduler uses internally
 * (`mulberry32` in `scheduler-grasp.ts`). It is duplicated here rather than
 * exported from that module so the scheduler's own reproducibility stays pinned
 * to code that is already covered by tests, and this stays independently usable.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export type RandomFn = () => number;

/**
 * Fisher-Yates shuffle, driven by a supplied generator so the caller owns
 * reproducibility. Returns a new array; the input is never mutated.
 */
export function shuffled<T>(items: readonly T[], random: RandomFn): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const left = result[i] as T;
    const right = result[j] as T;
    result[i] = right;
    result[j] = left;
  }
  return result;
}

/** A seed derived from a string, so a tournament id can drive the shuffle. */
export function seedFromString(value: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
