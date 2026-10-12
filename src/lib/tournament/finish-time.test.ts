import { describe, expect, it } from "vitest";

import { clockFromMinutesAgo, minutesAgoFromClock } from "./finish-time";

// 2026-10-10 14:30 UTC is 09:30 in Chicago (CDT, UTC-5) and 23:30 in Tokyo (UTC+9).
const NOW = new Date("2026-10-10T14:30:00Z");

describe("minutesAgoFromClock", () => {
  it("reads the entry on the venue's wall clock, not the device's", () => {
    expect(minutesAgoFromClock("09:15", NOW, "America/Chicago")).toBe(15);
    expect(minutesAgoFromClock("23:00", NOW, "Asia/Tokyo")).toBe(30);
  });

  it("answers zero for the current minute", () => {
    expect(minutesAgoFromClock("09:30", NOW, "America/Chicago")).toBe(0);
  });

  it("forgives a few minutes of drift between two clocks", () => {
    expect(minutesAgoFromClock("09:32", NOW, "America/Chicago")).toBe(0);
  });

  it("reads a time later than that as yesterday, which the caller's maximum then refuses", () => {
    // 09:45 is 15 min ahead of 09:30: not drift, so it comes back as almost a full day ago.
    expect(minutesAgoFromClock("09:45", NOW, "America/Chicago")).toBe(24 * 60 - 15);
  });

  it("crosses midnight", () => {
    const justAfterMidnight = new Date("2026-10-10T05:10:00Z"); // 00:10 in Chicago
    expect(minutesAgoFromClock("23:50", justAfterMidnight, "America/Chicago")).toBe(20);
  });

  it("returns null for anything that is not a time", () => {
    for (const bad of ["", "9", "25:00", "12:60", "noon", "12:3"]) {
      expect(minutesAgoFromClock(bad, NOW, "America/Chicago"), bad).toBeNull();
    }
  });
});

describe("clockFromMinutesAgo", () => {
  it("is the inverse, so the hint under the chips matches what was chosen", () => {
    expect(clockFromMinutesAgo(0, NOW, "America/Chicago")).toBe("09:30");
    expect(clockFromMinutesAgo(5, NOW, "America/Chicago")).toBe("09:25");
    expect(clockFromMinutesAgo(45, NOW, "America/Chicago")).toBe("08:45");
  });

  it("wraps past midnight", () => {
    const justAfterMidnight = new Date("2026-10-10T05:10:00Z");
    expect(clockFromMinutesAgo(20, justAfterMidnight, "America/Chicago")).toBe("23:50");
  });
});
