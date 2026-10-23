import { describe, expect, it } from "vitest";

import {
  courtHoursOffered,
  estimateCapacity,
  knockoutMatchCount,
  placementMatchCount,
} from "./capacity-estimate";

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

describe("courtHoursOffered", () => {
  it("is each day's courts times its window less breaks", () => {
    expect(
      courtHoursOffered([
        { courts: 4, windowMinutes: 540, breakMinutes: 60 }, // 4 x 8h
        { courts: 2, windowMinutes: 480, breakMinutes: 0 }, // 2 x 8h
      ]),
    ).toBe(48);
  });
  it("counts a day with no courts as nothing", () => {
    expect(courtHoursOffered([{ courts: 0, windowMinutes: 600, breakMinutes: 0 }])).toBe(0);
  });
  it("replaces courts x hours x days in the estimate", () => {
    const result = estimateCapacity({
      entrantsPerEvent: [16],
      courtHoursOffered: 32,
    });
    expect(result.courtHoursAvailable).toBe(32);
    expect(result.verdict).toBe("fits");
  });
  it("reads the offered total it is given rather than a plan it was not given", () => {
    // The trap this guards: a caller that supplied only the offered side used to fall back to
    // 0 x 0 x 0 and call a comfortable tournament impossible.
    const result = estimateCapacity({ entrantsPerEvent: [16], courtHoursOffered: 0 });
    expect(result.courtHoursAvailable).toBe(0);
    expect(result.verdict).toBe("over");
  });
});
