import { describe, expect, it } from "vitest";

import { estimateCapacity, knockoutMatchCount, placementMatchCount } from "./capacity-estimate";

describe("placementMatchCount", () => {
  it("is none for one entrant, one for two, and one per entrant from three", () => {
    expect([0, 1, 2, 3, 8, 9].map(placementMatchCount)).toEqual([0, 0, 1, 3, 8, 9]);
  });
});

describe("knockoutMatchCount", () => {
  it("splits the field evenly into four draws, each playing entrants minus one", () => {
    expect(knockoutMatchCount(16)).toBe(12); // four draws of 4 -> 3 each
    expect(knockoutMatchCount(18)).toBe(14); // 4,4,4,6 -> 3+3+3+5
  });
  it("plays nothing for a field of one", () => {
    expect(knockoutMatchCount(1)).toBe(0);
  });
});

describe("estimateCapacity", () => {
  const base = { entrantsPerEvent: [16], courts: 2, hoursPerDay: 8, days: 1 };

  it("adds the two stages at their own slot lengths", () => {
    const result = estimateCapacity(base);
    expect(result.placementMatches).toBe(16);
    expect(result.knockoutMatches).toBe(12);
    expect(result.courtHoursNeeded).toBeCloseTo((16 * 20 + 12 * 25) / 60);
  });

  it("fits with room to spare, is tight near capacity, and is over beyond it", () => {
    expect(estimateCapacity({ ...base, courts: 4 }).verdict).toBe("fits");
    expect(estimateCapacity({ ...base, courts: 2, hoursPerDay: 5.3 }).verdict).toBe("tight");
    expect(estimateCapacity({ ...base, courts: 1 }).verdict).toBe("over");
  });

  it("is over when there is no court time at all", () => {
    expect(estimateCapacity({ ...base, courts: 0 }).verdict).toBe("over");
  });
});
