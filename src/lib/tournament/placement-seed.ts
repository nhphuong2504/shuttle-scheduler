/**
 * Skill-block seeding for the two-round placement format.
 *
 * Skill level is self-reported by the entrant and used exactly ONCE: to decide
 * the initial seed. Every pairing rule after this reads `seed` only, never
 * `skill_level`, so no downstream code has to remember which block an entrant
 * came from. That decoupling is what keeps the pairing rules simple.
 *
 * Seeds are assigned in contiguous blocks, strongest block first, and shuffled
 * *within* each block:
 *
 *   seeds 1..a        advanced     (shuffled inside the block)
 *   seeds a+1..a+b    intermediate (shuffled inside the block)
 *   seeds a+b+1..N    beginner     (shuffled inside the block)
 *
 * The shuffle is one-shot and stored permanently, so "why did I face this
 * person" always has the same answer.
 */

import { shuffled, type RandomFn } from "./rng";

export type SkillLevel = "advanced" | "intermediate" | "beginner";

/** Strongest first. This order is what puts advanced entrants on the low seeds. */
export const SKILL_LEVELS: readonly SkillLevel[] = ["advanced", "intermediate", "beginner"];

export const SKILL_LABELS: Record<SkillLevel, string> = {
  advanced: "Advanced",
  intermediate: "Intermediate",
  beginner: "Beginner",
};

/**
 * What an unnamed skill level falls back to. "Intermediate" is the least
 * surprising default: it neither flatters nor penalises an entrant, and it sits
 * in the middle of the seed list rather than at an end.
 */
export const DEFAULT_SKILL_LEVEL: SkillLevel = "intermediate";

export function isSkillLevel(value: unknown): value is SkillLevel {
  return typeof value === "string" && (SKILL_LEVELS as readonly string[]).includes(value);
}

export interface SeedableEntrant {
  id: string;
  /** Null or missing is treated as `DEFAULT_SKILL_LEVEL`. */
  skillLevel?: SkillLevel | null | undefined;
}

export interface AssignedSeed {
  id: string;
  seed: number;
  skillLevel: SkillLevel;
}

export interface SkillCounts {
  advanced: number;
  intermediate: number;
  beginner: number;
  total: number;
}

/** A contiguous seed range owned by one skill block, for display and audit. */
export interface SkillBlock {
  level: SkillLevel;
  label: string;
  count: number;
  /** 1-based, inclusive. Zero-count blocks report firstSeed > lastSeed. */
  firstSeed: number;
  lastSeed: number;
}

export function buildSkillCounts(entrants: readonly SeedableEntrant[]): SkillCounts {
  const counts: SkillCounts = { advanced: 0, intermediate: 0, beginner: 0, total: 0 };
  for (const entrant of entrants) {
    const level = entrant.skillLevel ?? DEFAULT_SKILL_LEVEL;
    counts[level]++;
    counts.total++;
  }
  return counts;
}

/**
 * The seed ranges each skill block received. Rendered in the UI so a host can
 * see the block boundaries rather than having to infer them.
 */
export function describeSkillBlocks(counts: SkillCounts): SkillBlock[] {
  const blocks: SkillBlock[] = [];
  let next = 1;
  for (const level of SKILL_LEVELS) {
    const count = counts[level];
    blocks.push({
      level,
      label: SKILL_LABELS[level],
      count,
      firstSeed: count > 0 ? next : next + 1,
      lastSeed: count > 0 ? next + count - 1 : next,
    });
    next += count;
  }
  return blocks;
}

/**
 * Which block is stronger, as a sortable number. Derived from `SKILL_LEVELS`
 * rather than written out, so the two orders cannot drift apart.
 */
const SKILL_RANK = new Map<SkillLevel, number>(SKILL_LEVELS.map((level, index) => [level, index]));

/**
 * Whether a seed order still groups entrants by the block they reported.
 *
 * `assignSeeds` follows the blocks by construction: every advanced entrant, then
 * every intermediate, then every beginner. A host can reorder the list by hand
 * afterwards, and this is what the seeding table reads to say so rather than
 * letting the panel keep claiming an order it no longer has.
 *
 * The test is a rank that never goes backwards: a weaker block may follow a
 * stronger one, never the reverse. That is exactly the contiguity the blocks had
 * when they were written, and it deliberately does not care about order *within*
 * a block, which was always random.
 *
 * Display only. Nothing downstream reads this, because every pairing rule reads
 * `seed` and nothing else — so a hand-made order is a legitimate order, just not
 * the one the blocks would have produced.
 *
 * Takes plain strings rather than `SkillLevel` because the caller reads them
 * straight off database rows, where the column is unconstrained text. Anything
 * unrecognised ranks as `DEFAULT_SKILL_LEVEL`, which is the same fallback
 * `buildSkillCounts` applies.
 */
export function followsSkillBlocks(levels: readonly (string | null | undefined)[]): boolean {
  let previous = -1;
  for (const level of levels) {
    const rank = SKILL_RANK.get(isSkillLevel(level) ? level : DEFAULT_SKILL_LEVEL) as number;
    if (rank < previous) return false;
    previous = rank;
  }
  return true;
}

/**
 * Assigns every entrant a permanent seed: contiguous blocks by skill, shuffled
 * within each block. Returns entrants ordered by seed.
 *
 * The returned order is the seed order, which is what round one pairs from.
 */
export function assignSeeds(
  entrants: readonly SeedableEntrant[],
  random: RandomFn,
): AssignedSeed[] {
  const byLevel = new Map<SkillLevel, SeedableEntrant[]>();
  for (const level of SKILL_LEVELS) byLevel.set(level, []);
  for (const entrant of entrants) {
    const level = entrant.skillLevel ?? DEFAULT_SKILL_LEVEL;
    (byLevel.get(level) as SeedableEntrant[]).push(entrant);
  }

  const ordered: AssignedSeed[] = [];
  for (const level of SKILL_LEVELS) {
    for (const entrant of shuffled(byLevel.get(level) as SeedableEntrant[], random)) {
      ordered.push({ id: entrant.id, seed: ordered.length + 1, skillLevel: level });
    }
  }
  return ordered;
}

/**
 * A host-facing warning when one skill block dominates the entry list. At that
 * ratio the block boundaries stop meaning anything, so seeding is close to a
 * plain random draw. This is surfaced for transparency; no special handling is
 * attempted, because there is no correct way to unpick a lopsided report.
 */
export const DEFAULT_SKEW_THRESHOLD = 0.75;

/** Below this many entrants a "skew" is just a small field, not a signal. */
export const DEFAULT_SKEW_MIN_ENTRANTS = 4;

export interface SkillSkewWarning {
  level: SkillLevel;
  label: string;
  count: number;
  total: number;
  share: number;
  threshold: number;
  message: string;
}

export function skillSkewWarning(
  counts: SkillCounts,
  threshold: number = DEFAULT_SKEW_THRESHOLD,
  minEntrants: number = DEFAULT_SKEW_MIN_ENTRANTS,
): SkillSkewWarning | null {
  if (counts.total < minEntrants) return null;

  let dominant: { level: SkillLevel; count: number } | null = null;
  for (const level of SKILL_LEVELS) {
    const count = counts[level];
    if (!dominant || count > dominant.count) dominant = { level, count };
  }
  if (!dominant) return null;

  const share = dominant.count / counts.total;
  if (share <= threshold) return null;

  const percent = Math.round(share * 100);
  return {
    level: dominant.level,
    label: SKILL_LABELS[dominant.level],
    count: dominant.count,
    total: counts.total,
    share,
    threshold,
    message:
      `${dominant.count} of ${counts.total} entrants (${percent}%) chose ` +
      `${SKILL_LABELS[dominant.level]}. At this ratio the skill blocks are close to ` +
      `meaningless, so seeding behaves much like a plain random draw.`,
  };
}
