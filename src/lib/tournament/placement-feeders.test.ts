import { describe, expect, it } from "vitest";
import {
  buildPlacementRoundTwo,
  pairPlacementRoundOne,
  type GeneratedPlacementMatch,
} from "./placement";
import { placementFeederSlots, resolvePlacementFeederSlots } from "./placement-feeders";

const entrants = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}`, seed: i + 1 }));
const pairing = (m: GeneratedPlacementMatch) => [m.key, m.entrantAId, m.entrantBId];

describe("fixed placement feeders", () => {
  it("preserves the batch algorithm for every outcome through 24 entrants, including lexical r1-10 ordering", () => {
    for (const n of [4, 8, 12, 16, 20, 24]) {
      const field = entrants(n);
      const r1 = pairPlacementRoundOne(field).matches.sort((a, b) => (a.key < b.key ? -1 : 1));
      const slots = placementFeederSlots(field, [...r1].reverse());
      expect(slots).toHaveLength(n / 2);
      for (let mask = 0; mask < 2 ** r1.length; mask++) {
        const winners = new Map(
          r1.map((m, i) => [m.key, mask & (1 << i) ? m.entrantAId : m.entrantBId]),
        );
        const old = buildPlacementRoundTwo({
          entrants: field,
          roundOne: r1,
          roundOneWinners: winners,
          heldEntrantId: null,
        });
        const ready = resolvePlacementFeederSlots(slots, r1, winners);
        expect(ready.map(pairing)).toEqual(old.matches.map(pairing));
        expect(ready.every((m) => m.prerequisiteKeys.length === 2)).toBe(true);
      }
    }
  });

  it("opens winner and loser matches after their two sources, without waiting on the other sources", () => {
    const field = entrants(8);
    const r1 = pairPlacementRoundOne(field).matches;
    const slots = placementFeederSlots(field, r1);
    const ready = resolvePlacementFeederSlots(
      slots,
      r1,
      new Map([
        ["r1-1", "e5"],
        ["r1-3", "e3"],
      ]),
    );
    expect(ready.map(pairing)).toEqual([
      ["r2-1", "e5", "e3"],
      ["r2-3", "e1", "e7"],
    ]);
    expect(resolvePlacementFeederSlots(slots, r1, new Map([["r1-1", "e5"]]))).toEqual([]);
    expect(
      resolvePlacementFeederSlots(
        slots,
        r1,
        new Map([
          ["r1-1", "unknown"],
          ["r1-3", "e3"],
        ]),
      ),
    ).toEqual([]);
  });

  it("leaves small, odd and crossover fields on the adaptive path", () => {
    for (const n of [0, 1, 2, 3, 5, 6, 7, 9, 10, 11]) {
      expect(placementFeederSlots(entrants(n), pairPlacementRoundOne(entrants(n)).matches)).toEqual(
        [],
      );
    }
  });

  it("refuses incomplete or duplicated round-one participation", () => {
    const field = entrants(8);
    const r1 = pairPlacementRoundOne(field).matches;
    expect(placementFeederSlots(field, r1.slice(1))).toEqual([]);
    expect(placementFeederSlots(field, [r1[0]!, r1[0]!, r1[2]!, r1[3]!])).toEqual([]);
    expect(
      placementFeederSlots(
        field,
        r1.map((m, i) => (i === 0 ? { ...m, entrantAId: "foreign" } : m)),
      ),
    ).toEqual([]);
  });
});
