import { describe, expect, it } from "vitest";

import { tierForRecord, type PlacementRecord } from "./competition-format";
import {
  buildPlacementRoundTwo,
  computePlacementOutcomes,
  halfSplitPairing,
  heldEntrantInterleaveCount,
  pairKey,
  pairPlacementRoundOne,
  placementGate,
  recordForResults,
  requiredPlacementMatches,
  PlacementRoundTwoError,
  type GeneratedPlacementMatch,
  type PlacementEntrantRef,
} from "./placement";
import {
  assignSeeds,
  buildSkillCounts,
  describeSkillBlocks,
  followsSkillBlocks,
  skillSkewWarning,
  type SeedableEntrant,
} from "./placement-seed";
import { mulberry32 } from "./rng";
import {
  buildTierBracket,
  childSlot,
  feederLabel,
  isTierMatchReady,
  nextTierRound,
  tierNeedsNoBracket,
} from "./tier-draw";

function entrantsFor(n: number): PlacementEntrantRef[] {
  return Array.from({ length: n }, (_, index) => ({ id: `e${index + 1}`, seed: index + 1 }));
}

/** Assigns winners to `matches` from consecutive bits of `mask`, starting at `offset`. */
function assignWinners(
  matches: readonly GeneratedPlacementMatch[],
  mask: number,
  offset: number,
): Map<string, string | null> {
  const winners = new Map<string, string | null>();
  matches.forEach((match, index) => {
    const aWins = ((mask >> (offset + index)) & 1) === 1;
    winners.set(match.key, aWins ? match.entrantAId : match.entrantBId);
  });
  return winners;
}

/**
 * Round one is the source of any round-two structure, and the mask is just an
 * enumeration device: every possible set of round-one winners is one mask.
 */
function buildStage(n: number, roundOneMask: number) {
  const entrants = entrantsFor(n);
  const roundOne = pairPlacementRoundOne(entrants);
  const roundOneWinners = assignWinners(roundOne.matches, roundOneMask, 0);
  const roundTwo = buildPlacementRoundTwo({
    entrants,
    roundOne: roundOne.matches,
    roundOneWinners,
    heldEntrantId: roundOne.heldEntrantId,
  });
  return { entrants, roundOne, roundTwo, roundOneWinners };
}

describe("pairPlacementRoundOne", () => {
  it("pairs across a half split, not strongest-vs-weakest", () => {
    const plan = pairPlacementRoundOne(entrantsFor(6));
    // ceil(6/2) = 3, so seed i meets seed 3+i. Standard bracket seeding would
    // have produced 1v6, which is exactly the predictable pairing to avoid.
    expect(plan.matches.map((m) => [m.entrantAId, m.entrantBId])).toEqual([
      ["e1", "e4"],
      ["e2", "e5"],
      ["e3", "e6"],
    ]);
    expect(plan.heldEntrantId).toBeNull();
  });

  it("holds the middle seed when the entry count is odd", () => {
    const plan = pairPlacementRoundOne(entrantsFor(5));
    expect(plan.matches.map((m) => [m.entrantAId, m.entrantBId])).toEqual([
      ["e1", "e4"],
      ["e2", "e5"],
    ]);
    // Seed 3 is the middle: held, with no row written for them at all.
    expect(plan.heldEntrantId).toBe("e3");
    expect(plan.matches.some((m) => m.entrantAId === "e3" || m.entrantBId === "e3")).toBe(false);
  });

  it("produces no matches for a field of one, holding the only entrant", () => {
    const plan = pairPlacementRoundOne(entrantsFor(1));
    expect(plan.matches).toEqual([]);
    expect(plan.heldEntrantId).toBe("e1");
  });

  it("produces no matches for an empty field", () => {
    const plan = pairPlacementRoundOne([]);
    expect(plan.matches).toEqual([]);
    expect(plan.heldEntrantId).toBeNull();
  });

  it("never writes a bye row, which is what keeps a bye neutral", () => {
    for (let n = 0; n <= 16; n++) {
      const plan = pairPlacementRoundOne(entrantsFor(n));
      for (const match of plan.matches) {
        expect(match.entrantAId).not.toBe(match.entrantBId);
        expect(match.entrantAId).toBeTruthy();
        expect(match.entrantBId).toBeTruthy();
        expect(match.isMakeup).toBe(false);
        expect(match.isCrossover).toBe(false);
      }
      expect(plan.matches.length).toBe(Math.floor(n / 2));
    }
  });
});

describe("halfSplitPairing", () => {
  it("leaves the middle element over for an odd count", () => {
    const { pairs, leftover } = halfSplitPairing(entrantsFor(7));
    expect(pairs.map((p) => [p[0].seed, p[1].seed])).toEqual([
      [1, 5],
      [2, 6],
      [3, 7],
    ]);
    expect(leftover?.seed).toBe(4);
  });

  it("leaves nothing over for an even count", () => {
    const { pairs, leftover } = halfSplitPairing(entrantsFor(4));
    expect(pairs.map((p) => [p[0].seed, p[1].seed])).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(leftover).toBeNull();
  });
});

describe("stage structure across every field size and every result", () => {
  // Sizes below three cannot satisfy the two-match invariant, so they are
  // covered separately by the small-field tests.
  const sizes = Array.from({ length: 14 }, (_, index) => index + 3);

  it("plays exactly N matches, with every entrant appearing exactly twice", () => {
    for (const n of sizes) {
      const masks = 1 << Math.floor(n / 2);
      for (let mask = 0; mask < masks; mask++) {
        const { entrants, roundOne, roundTwo } = buildStage(n, mask);
        const all = [...roundOne.matches, ...roundTwo.matches];

        expect(all.length).toBe(n);

        const appearances = new Map<string, number>();
        for (const match of all) {
          appearances.set(match.entrantAId, (appearances.get(match.entrantAId) ?? 0) + 1);
          appearances.set(match.entrantBId, (appearances.get(match.entrantBId) ?? 0) + 1);
        }
        for (const entrant of entrants) {
          expect(appearances.get(entrant.id)).toBe(2);
        }
      }
    }
  });

  it("never pairs the same two entrants twice, including in the crossover", () => {
    for (const n of sizes) {
      const masks = 1 << Math.floor(n / 2);
      for (let mask = 0; mask < masks; mask++) {
        const { roundOne, roundTwo } = buildStage(n, mask);
        const seen = new Set<string>();
        for (const match of [...roundOne.matches, ...roundTwo.matches]) {
          const key = pairKey(match.entrantAId, match.entrantBId);
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it("uses a crossover exactly when N mod 4 is 1 or 2", () => {
    for (const n of sizes) {
      const expected = n % 4 === 1 || n % 4 === 2;
      const masks = 1 << Math.floor(n / 2);
      for (let mask = 0; mask < masks; mask++) {
        const { roundTwo } = buildStage(n, mask);
        expect(roundTwo.usedCrossover, `N=${n} mask=${mask}`).toBe(expected);
      }
    }
  });

  it("pairs within sections, so an internal match is never a rematch", () => {
    // A round-one match always contributes its winner to W and its loser to L, so
    // two entrants who met in round one can never share a section. Only the
    // crossover needed guarding, which the duplicate-pairing test covers.
    for (const n of sizes) {
      const masks = 1 << Math.floor(n / 2);
      for (let mask = 0; mask < masks; mask++) {
        const { roundOne, roundTwo } = buildStage(n, mask);
        const roundOnePairings = new Set(
          roundOne.matches.map((match) => pairKey(match.entrantAId, match.entrantBId)),
        );
        for (const match of roundTwo.matches) {
          if (match.isCrossover) continue;
          expect(
            roundOnePairings.has(pairKey(match.entrantAId, match.entrantBId)),
            `N=${n} mask=${mask} internal match ${match.key}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("held entrant make-up matches", () => {
  it("plays one round-one winner and one round-one loser", () => {
    const { roundOne, roundTwo } = buildStage(7, 0b111);
    const makeups = roundTwo.matches.filter((match) => match.isMakeup);
    expect(makeups).toHaveLength(2);
    for (const match of makeups) {
      expect([match.entrantAId, match.entrantBId]).toContain(roundOne.heldEntrantId);
    }
  });

  it("picks opponents by nearest seed, breaking ties toward the weaker seed", () => {
    // N = 5: seeds are held at 3, winners are 1 and 2 and losers are 4 and 5 when
    // the first two matches go to seed A. Nearest to seed 3 is seed 2 (distance 1)
    // and seed 4 (distance 1), with no tie to break.
    const { roundTwo } = buildStage(5, 0b11);
    const makeups = roundTwo.matches.filter((match) => match.isMakeup);
    const opponents = makeups.map((match) =>
      match.entrantAId === "e3" ? match.entrantBId : match.entrantAId,
    );
    expect(opponents.sort()).toEqual(["e2", "e4"]);
  });

  it("waits for its first match plus k other round-two matches", () => {
    for (const n of [5, 7, 9, 11, 13, 15]) {
      const { roundTwo } = buildStage(n, 0);
      const second = roundTwo.matches.find((match) => match.key === "r2-makeup-2");
      expect(second).toBeDefined();
      const k = heldEntrantInterleaveCount(n);
      const others = roundTwo.matches.filter(
        (match) => match.key !== "r2-makeup-1" && match.key !== "r2-makeup-2",
      );
      // The first match always gates the second, plus k other matches.
      expect(second?.prerequisiteKeys).toHaveLength(1 + Math.min(k, others.length));
      expect(second?.prerequisiteKeys).toContain("r2-makeup-1");
    }
  });

  it("scales the interleave count with the field size and never exceeds the cap", () => {
    expect(heldEntrantInterleaveCount(1)).toBe(0);
    expect(heldEntrantInterleaveCount(2)).toBe(0);
    expect(heldEntrantInterleaveCount(3)).toBe(0);
    expect(heldEntrantInterleaveCount(5)).toBe(1);
    expect(heldEntrantInterleaveCount(7)).toBe(2);
    expect(heldEntrantInterleaveCount(9)).toBe(3);
    // Capped from here on.
    expect(heldEntrantInterleaveCount(21)).toBe(3);
    expect(heldEntrantInterleaveCount(41)).toBe(3);
  });

  it("has enough round-two matches to satisfy the interleave gap at every size", () => {
    // Feasibility matters: if k other matches did not exist, the held entrant's
    // second match would wait on a match that can never happen, and the schedule
    // would deadlock rather than simply run long.
    for (let n = 3; n <= 41; n++) {
      const { roundTwo } = buildStage(n, 0);
      const others = roundTwo.matches.filter(
        (match) => match.key !== "r2-makeup-1" && match.key !== "r2-makeup-2",
      );
      if (n % 2 === 0) continue;
      expect(others.length, `N=${n}`).toBeGreaterThanOrEqual(heldEntrantInterleaveCount(n));
    }
  });

  it("refuses to build round two while a round-one match is undecided", () => {
    const entrants = entrantsFor(4);
    const roundOne = pairPlacementRoundOne(entrants);
    const winners = new Map<string, string | null>([
      [(roundOne.matches[0] as GeneratedPlacementMatch).key, "e1"],
      [(roundOne.matches[1] as GeneratedPlacementMatch).key, null],
    ]);
    expect(() =>
      buildPlacementRoundTwo({
        entrants,
        roundOne: roundOne.matches,
        roundOneWinners: winners,
        heldEntrantId: null,
      }),
    ).toThrow(PlacementRoundTwoError);
  });
});

describe("small fields", () => {
  it("requires no matches of a single entrant, and one of a pair", () => {
    expect(requiredPlacementMatches(0)).toBe(0);
    expect(requiredPlacementMatches(1)).toBe(0);
    expect(requiredPlacementMatches(2)).toBe(1);
    expect(requiredPlacementMatches(3)).toBe(2);
    expect(requiredPlacementMatches(16)).toBe(2);
  });

  it("puts the sole entrant of a field of one straight into Draw A", () => {
    const entrants = entrantsFor(1);
    const outcomes = computePlacementOutcomes({ entrants, matches: [], winners: new Map() });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.tier).toBe("A");
    expect(outcomes[0]?.record).toBeNull();
    expect(outcomes[0]?.played).toBe(0);
  });

  it("stops a field of two after one match, with winner to A and loser to D", () => {
    const entrants = entrantsFor(2);
    const roundOne = pairPlacementRoundOne(entrants);
    expect(roundOne.matches).toHaveLength(1);

    const winners = new Map<string, string | null>([
      [(roundOne.matches[0] as GeneratedPlacementMatch).key, "e1"],
    ]);
    const outcomes = computePlacementOutcomes({
      entrants,
      matches: roundOne.matches,
      winners,
    });
    const byId = new Map(outcomes.map((outcome) => [outcome.entrantId, outcome]));
    expect(byId.get("e1")?.tier).toBe("A");
    expect(byId.get("e2")?.tier).toBe("D");
    // No crossover is attempted, which would replay the only possible match.
    expect(roundOne.heldEntrantId).toBeNull();
  });

  it("builds a complete stage for a field of three", () => {
    const { entrants, roundOne, roundTwo, roundOneWinners } = buildStage(3, 0b1);
    expect(roundOne.heldEntrantId).toBe("e2");
    expect(roundOne.matches).toHaveLength(1);
    expect(roundTwo.matches).toHaveLength(2);
    expect(roundTwo.usedCrossover).toBe(false);

    const winners = new Map(roundOneWinners);
    roundTwo.matches.forEach((match) => winners.set(match.key, match.entrantAId));
    const outcomes = computePlacementOutcomes({
      entrants,
      matches: [...roundOne.matches, ...roundTwo.matches],
      winners,
    });
    for (const outcome of outcomes) {
      expect(outcome.played).toBe(2);
      expect(outcome.tier).not.toBeNull();
    }
  });
});

describe("tier assignment from records", () => {
  it("maps the two results to a record and a tier", () => {
    expect(recordForResults(true, true)).toBe("WW");
    expect(recordForResults(true, false)).toBe("WL");
    expect(recordForResults(false, true)).toBe("LW");
    expect(recordForResults(false, false)).toBe("LL");
  });

  it("gives every entrant a full record and a tier for every field of three or more", () => {
    for (let n = 3; n <= 10; n++) {
      // Every combination of results across all N matches.
      for (let mask = 0; mask < 1 << n; mask++) {
        const entrants = entrantsFor(n);
        const roundOne = pairPlacementRoundOne(entrants);
        const roundOneWinners = assignWinners(roundOne.matches, mask, 0);
        const roundTwo = buildPlacementRoundTwo({
          entrants,
          roundOne: roundOne.matches,
          roundOneWinners,
          heldEntrantId: roundOne.heldEntrantId,
        });
        const roundTwoWinners = assignWinners(roundTwo.matches, mask, roundOne.matches.length);
        const winners = new Map([...roundOneWinners, ...roundTwoWinners]);

        const outcomes = computePlacementOutcomes({
          entrants,
          matches: [...roundOne.matches, ...roundTwo.matches],
          winners,
        });

        expect(outcomes).toHaveLength(n);
        for (const outcome of outcomes) {
          expect(outcome.played, `N=${n}`).toBe(2);
          expect(outcome.record).not.toBeNull();
          expect(outcome.tier).not.toBeNull();
        }

        // Every match produces exactly one win and exactly one loss, so both
        // totals are pinned to the match count: N matches for a field of N.
        // This is a real check on the crossover and make-up bookkeeping, because
        // a pairing mistake would leave the totals off by the stray matches.
        const totalWins = outcomes.reduce((sum, outcome) => sum + outcome.wins, 0);
        const totalLosses = outcomes.reduce((sum, outcome) => sum + outcome.losses, 0);
        expect(totalWins, `N=${n}`).toBe(n);
        expect(totalLosses, `N=${n}`).toBe(n);

        const byRecord: Record<PlacementRecord, number> = { WW: 0, WL: 0, LW: 0, LL: 0 };
        for (const outcome of outcomes) {
          expect(outcome.tier).toBe(tierForRecord(outcome.record as PlacementRecord));
          byRecord[outcome.record as PlacementRecord]++;
        }
        // Tiers follow the records exactly: A=WW, B=WL, C=LW, D=LL.
        expect(byRecord.WW + byRecord.WL + byRecord.LW + byRecord.LL).toBe(n);
      }
    }
  });

  it("sends the crossover winner to the tier its record earns", () => {
    const n = 6;
    for (let mask = 0; mask < 1 << n; mask++) {
      const entrants = entrantsFor(n);
      const roundOne = pairPlacementRoundOne(entrants);
      const roundOneWinners = assignWinners(roundOne.matches, mask, 0);
      const roundTwo = buildPlacementRoundTwo({
        entrants,
        roundOne: roundOne.matches,
        roundOneWinners,
        heldEntrantId: roundOne.heldEntrantId,
      });
      const crossover = roundTwo.matches.find((match) => match.isCrossover);
      expect(crossover).toBeDefined();
      const roundTwoWinners = assignWinners(roundTwo.matches, mask, roundOne.matches.length);
      const outcomes = computePlacementOutcomes({
        entrants,
        matches: [...roundOne.matches, ...roundTwo.matches],
        winners: new Map([...roundOneWinners, ...roundTwoWinners]),
      });
      const byId = new Map(outcomes.map((outcome) => [outcome.entrantId, outcome]));

      const winnerId = roundTwoWinners.get((crossover as GeneratedPlacementMatch).key) as string;
      const winner = byId.get(winnerId);
      expect(winner).toBeDefined();
      // A leftover winner who wins the crossover is WW; a leftover loser who
      // wins it is LW. That asymmetry is the whole point of the mechanism.
      if (winner?.firstWon) expect(winner.record).toBe("WW");
      else expect(winner?.record).toBe("LW");
    }
  });
});

describe("placementGate", () => {
  const entrants = entrantsFor(4);

  it("blocks until every entrant has both matches decided", () => {
    const roundOne = pairPlacementRoundOne(entrants);
    const winners = assignWinners(roundOne.matches, 0b01, 0);
    const outcomes = computePlacementOutcomes({
      entrants,
      matches: roundOne.matches,
      winners,
    });
    const gate = placementGate(entrants, outcomes);
    expect(gate.ready).toBe(false);
    expect(gate.requiredMatches).toBe(2);
    expect(gate.short).toHaveLength(4);
    // Round one covers the whole field, so after it every entrant sits on exactly
    // one decided match and the gate is one round away from opening.
    expect(gate.short.every((entry) => entry.played === 1)).toBe(true);
  });

  it("skips a waived entrant instead of letting one void stall the category", () => {
    const withWaiver = entrants.map((entrant) =>
      entrant.id === "e1" ? { ...entrant, excluded: true } : entrant,
    );
    const outcomes = entrantsFor(4).map((entrant) => ({
      entrantId: entrant.id,
      seed: entrant.seed,
      played: entrant.id === "e1" ? 0 : 2,
      wins: 1,
      losses: 1,
      firstWon: true,
      secondWon: false,
      isHeld: false,
      record: "WL" as const,
      tier: "B" as const,
    }));

    const gate = placementGate(withWaiver, outcomes);
    expect(gate.excluded).toBe(1);
    expect(gate.counted).toBe(3);
    expect(gate.ready).toBe(true);
    // The waived entrant is counted in the field size only if the requirement
    // were wrongly derived from the unfiltered list; four entrants need two
    // matches, and one of them has played none.
    expect(gate.requiredMatches).toBe(2);
  });

  it("derives the requirement from the playing field, not including waivers", () => {
    // Two active entrants need ONE match, even with a waived third in the list.
    // Deriving it from the unfiltered list would demand two and deadlock the
    // category behind a waiver. This mirrors `placement_required_matches`.
    const list = [
      { id: "e1", seed: 1 },
      { id: "e2", seed: 2 },
      { id: "e3", seed: 3, excluded: true },
    ];
    const outcomes = [
      {
        entrantId: "e1",
        seed: 1,
        played: 1,
        wins: 1,
        losses: 0,
        firstWon: true,
        secondWon: null,
        isHeld: false,
        record: null,
        tier: null,
      },
      {
        entrantId: "e2",
        seed: 2,
        played: 1,
        wins: 0,
        losses: 1,
        firstWon: false,
        secondWon: null,
        isHeld: false,
        record: null,
        tier: null,
      },
    ];

    const gate = placementGate(list, outcomes);
    expect(gate.requiredMatches).toBe(1);
    expect(gate.counted).toBe(2);
    expect(gate.ready).toBe(true);
  });
});

describe("skill-block seeding", () => {
  const sample: SeedableEntrant[] = [
    { id: "a1", skillLevel: "advanced" },
    { id: "a2", skillLevel: "advanced" },
    { id: "i1", skillLevel: "intermediate" },
    { id: "i2", skillLevel: "intermediate" },
    { id: "i3", skillLevel: "intermediate" },
    { id: "b1", skillLevel: "beginner" },
    { id: "b2", skillLevel: "beginner" },
  ];

  it("gives the lowest seeds to the strongest block and keeps blocks contiguous", () => {
    const seeds = assignSeeds(sample, mulberry32(1));
    const seedById = new Map(seeds.map((entry) => [entry.id, entry.seed]));

    const advanced = [...seeds].filter((entry) => entry.skillLevel === "advanced");
    const intermediate = [...seeds].filter((entry) => entry.skillLevel === "intermediate");
    const beginner = [...seeds].filter((entry) => entry.skillLevel === "beginner");

    expect(advanced.map((entry) => entry.seed).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(intermediate.map((entry) => entry.seed).sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(beginner.map((entry) => entry.seed).sort((a, b) => a - b)).toEqual([6, 7]);
    expect(seedById.size).toBe(sample.length);
  });

  it("is reproducible for the same seed and reorders within a block for different seeds", () => {
    const first = assignSeeds(sample, mulberry32(42));
    const second = assignSeeds(sample, mulberry32(42));
    expect(first).toEqual(second);

    // The shuffle is real: some other seed must produce a different in-block order.
    const otherSeeds = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
      assignSeeds(sample, mulberry32(seed))
        .filter((entry) => entry.skillLevel === "intermediate")
        .map((entry) => entry.id)
        .join(","),
    );
    expect(new Set(otherSeeds).size).toBeGreaterThan(1);
  });

  it("treats a missing skill level as intermediate", () => {
    const counts = buildSkillCounts([{ id: "x" }, { id: "y", skillLevel: null }]);
    expect(counts.intermediate).toBe(2);
    expect(counts.total).toBe(2);
  });

  it("describes the seed range each block received", () => {
    const blocks = describeSkillBlocks(buildSkillCounts(sample));
    expect(blocks.map((block) => [block.level, block.firstSeed, block.lastSeed])).toEqual([
      ["advanced", 1, 2],
      ["intermediate", 3, 5],
      ["beginner", 6, 7],
    ]);
  });

  it("warns only when one block dominates the field", () => {
    const flat = buildSkillCounts([
      { id: "1", skillLevel: "advanced" },
      { id: "2", skillLevel: "intermediate" },
      { id: "3", skillLevel: "intermediate" },
      { id: "4", skillLevel: "beginner" },
    ]);
    expect(skillSkewWarning(flat)).toBeNull();

    const skewed = buildSkillCounts([
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `i${i}`,
        skillLevel: "intermediate" as const,
      })),
      { id: "b", skillLevel: "beginner" as const },
    ]);
    const warning = skillSkewWarning(skewed);
    expect(warning).not.toBeNull();
    expect(warning?.level).toBe("intermediate");
    expect(warning?.count).toBe(9);
    expect(warning?.message).toContain("90%");

    // A tiny field is not evidence of anything.
    const tiny = buildSkillCounts([
      { id: "1", skillLevel: "beginner" },
      { id: "2", skillLevel: "beginner" },
    ]);
    expect(skillSkewWarning(tiny)).toBeNull();
  });

  it("recognises the shuffled order as following the blocks", () => {
    const seeds = assignSeeds(sample, mulberry32(7));
    expect(followsSkillBlocks(seeds.map((entry) => entry.skillLevel))).toBe(true);
  });

  it("notices an entrant dragged across a block boundary", () => {
    // A beginner moved to the top: a weaker block now sits above a stronger one.
    expect(followsSkillBlocks(["beginner", "advanced", "intermediate"])).toBe(false);
    // The same names in block order are not a deviation at all.
    expect(followsSkillBlocks(["advanced", "intermediate", "beginner"])).toBe(true);
  });

  it("does not care about the order within a block", () => {
    // Inside a block the order was already random, so reordering there is not a
    // deviation from anything the blocks claimed.
    expect(followsSkillBlocks(["advanced", "advanced", "beginner", "beginner"])).toBe(true);
    expect(followsSkillBlocks(["beginner", "beginner", "intermediate"])).toBe(false);
  });

  it("ranks a missing or unrecognised level as intermediate", () => {
    // The fallback `buildSkillCounts` applies, so the panel's note cannot disagree
    // with the block counts printed beside it.
    expect(followsSkillBlocks(["advanced", null, "beginner"])).toBe(true);
    expect(followsSkillBlocks([null, "advanced"])).toBe(false);
    expect(followsSkillBlocks(["beginner", undefined])).toBe(false);
    expect(followsSkillBlocks(["expert", "advanced"])).toBe(false);
  });

  it("accepts an empty field", () => {
    expect(followsSkillBlocks([])).toBe(true);
  });
});

describe("tier knockout brackets", () => {
  it("gives no bracket to an empty tier", () => {
    const plan = buildTierBracket("D", []);
    expect(plan.matches).toEqual([]);
    expect(plan.championId).toBeNull();
    expect(plan.bracketSize).toBe(0);
    expect(tierNeedsNoBracket(0)).toBe(true);
  });

  it("crowns a lone entrant immediately, with no bracket", () => {
    const plan = buildTierBracket("C", [{ id: "solo", seed: 9 }]);
    expect(plan.championId).toBe("solo");
    expect(plan.matches).toEqual([]);
    expect(tierNeedsNoBracket(1)).toBe(true);
  });

  it("pairs a clean bracket by standard seeding, with no byes", () => {
    const plan = buildTierBracket(
      "A",
      entrantsFor(4).map((entrant) => ({ id: entrant.id, seed: entrant.seed })),
    );
    expect(plan.bracketSize).toBe(4);
    expect(plan.byes).toBe(0);
    // Standard bracket order for four: 1v4 and 2v3.
    const roundOne = plan.matches.filter((match) => match.round === 1);
    expect(roundOne.map((match) => [match.entrantAId, match.entrantBId])).toEqual([
      ["e1", "e4"],
      ["e2", "e3"],
    ]);
    for (const match of plan.matches) expect(match.isBye).toBe(false);
    // The whole path to the final exists up front, with nobody decided yet.
    expect(plan.matches.filter((match) => match.round === 2)).toEqual([
      { round: 2, slot: 1, entrantAId: null, entrantBId: null, winnerId: null, isBye: false },
    ]);
  });

  it("gives byes to the highest seeds", () => {
    const plan = buildTierBracket(
      "B",
      entrantsFor(5).map((entrant) => ({ id: entrant.id, seed: entrant.seed })),
    );
    expect(plan.bracketSize).toBe(8);
    expect(plan.byes).toBe(3);

    const byes = plan.matches.filter((match) => match.isBye);
    const roundTwo = plan.matches.filter((match) => match.round === 2);
    // Byes are advanced at once: seeds 1 and 2/3 already wait in round two.
    expect(roundTwo.map((m) => [m.slot, m.entrantAId, m.entrantBId])).toEqual([
      [1, "e1", null],
      [2, "e2", "e3"],
    ]);
    expect(plan.matches.filter((match) => match.round === 3)).toHaveLength(1);
    expect(byes).toHaveLength(3);
    // Seeds 1, 2 and 3 are the ones left without an opponent.
    expect(byes.map((match) => match.winnerId).sort()).toEqual(["e1", "e2", "e3"]);
    // A bye is already decided, so it never needs to be played.
    expect(plan.matches.filter((match) => match.round === 1 && !match.isBye)).toHaveLength(1);
  });

  it("orders each tier by the original seed, never a fresh shuffle", () => {
    const plan = buildTierBracket("A", [
      { id: "late", seed: 12 },
      { id: "early", seed: 3 },
      { id: "middle", seed: 7 },
      { id: "last", seed: 19 },
    ]);
    expect(plan.matches[0]?.entrantAId).toBe("early");
    expect(plan.matches[0]?.entrantBId).toBe("last");
    expect(plan.matches).toHaveLength(3);
  });

  it("pairs adjacent slots when a round completes", () => {
    const next = nextTierRound(
      [
        { slot: 1, winnerId: "w1" },
        { slot: 2, winnerId: "w2" },
        { slot: 3, winnerId: "w3" },
        { slot: 4, winnerId: "w4" },
      ],
      2,
    );
    expect(next.map((match) => [match.slot, match.entrantAId, match.entrantBId])).toEqual([
      [1, "w1", "w2"],
      [2, "w3", "w4"],
    ]);
    expect(next.every((match) => match.isBye === false)).toBe(true);
  });

  it("routes a winner to the child slot: odd slots feed side A, even side B", () => {
    expect(childSlot(1)).toEqual({ slot: 1, side: "a" });
    expect(childSlot(2)).toEqual({ slot: 1, side: "b" });
    expect(childSlot(3)).toEqual({ slot: 2, side: "a" });
    expect(childSlot(4)).toEqual({ slot: 2, side: "b" });
  });

  it("builds every round for every bracket size, ending in one final", () => {
    for (let n = 2; n <= 32; n++) {
      const plan = buildTierBracket("A", entrantsFor(n).map((e) => ({ id: e.id, seed: e.seed })));
      const total = plan.matches.length;
      // Single elimination over a power-of-two bracket has size - 1 slots.
      expect(total).toBe(plan.bracketSize - 1);
      expect(plan.matches.filter((m) => m.round === Math.log2(plan.bracketSize))).toHaveLength(1);
    }
  });

  it("only calls a match ready when both sides are known and it is not a bye", () => {
    expect(isTierMatchReady({ entrantAId: "a", entrantBId: "b" })).toBe(true);
    expect(isTierMatchReady({ entrantAId: "a", entrantBId: null })).toBe(false);
    expect(isTierMatchReady({ entrantAId: "a", entrantBId: "b", isBye: true })).toBe(false);
    expect(isTierMatchReady({ entrantAId: "a", entrantBId: "b", status: "void" })).toBe(false);
  });
});

describe("feederLabel", () => {
  it("names where an undecided side comes from, and leaves round one as TBC", () => {
    expect(feederLabel(8, 1, 1, "a")).toBe("TBC");
    expect(feederLabel(8, 2, 1, "a")).toBe("Winner of Quarterfinal 1");
    expect(feederLabel(8, 2, 2, "b")).toBe("Winner of Quarterfinal 4");
    expect(feederLabel(8, 3, 1, "b")).toBe("Winner of Semifinal 2");
  });
});
