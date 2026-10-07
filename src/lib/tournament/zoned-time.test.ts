import { describe, expect, it } from "vitest";

import {
  instantToZoned,
  isValidTimeZone,
  nowInZone,
  startOfDayInstant,
  zonedToInstant,
} from "./zoned-time";

describe("zonedToInstant", () => {
  it("reads a wall-clock time in the venue's zone, not the browser's", () => {
    // Chicago is UTC-5 in October (daylight time).
    expect(zonedToInstant("2026-10-24T00:00", "America/Chicago")).toBe("2026-10-24T05:00:00.000Z");
    // Tokyo is UTC+9 all year.
    expect(zonedToInstant("2026-10-24T00:00", "Asia/Tokyo")).toBe("2026-10-23T15:00:00.000Z");
    expect(zonedToInstant("2026-10-24T09:30", "UTC")).toBe("2026-10-24T09:30:00.000Z");
  });

  it("uses winter time once the clocks have gone back", () => {
    // Chicago is UTC-6 after 1 November 2026.
    expect(zonedToInstant("2026-11-14T00:00", "America/Chicago")).toBe("2026-11-14T06:00:00.000Z");
  });

  it("settles a time next to a daylight-saving change on the right side of it", () => {
    // Clocks in Chicago go back at 02:00 on 1 November 2026; 03:00 is unambiguously winter.
    expect(zonedToInstant("2026-11-01T03:00", "America/Chicago")).toBe("2026-11-01T09:00:00.000Z");
    // And 01:00 the same morning is still summer time.
    expect(zonedToInstant("2026-11-01T01:00", "America/Chicago")).toBe("2026-11-01T06:00:00.000Z");
  });

  it("refuses a string that is not a wall-clock time, or an unknown zone", () => {
    expect(zonedToInstant("2026-10-24", "UTC")).toBeNull();
    expect(zonedToInstant("", "UTC")).toBeNull();
    expect(zonedToInstant("2026-10-24T00:00", "Not/AZone")).toBeNull();
  });
});

describe("instantToZoned", () => {
  it("shows a stored instant as the venue's wall clock", () => {
    expect(instantToZoned("2026-10-24T05:00:00.000Z", "America/Chicago")).toBe("2026-10-24T00:00");
    expect(instantToZoned("2026-10-23T15:00:00Z", "Asia/Tokyo")).toBe("2026-10-24T00:00");
  });

  it("round-trips with zonedToInstant", () => {
    for (const zone of ["America/Chicago", "Europe/London", "Asia/Kolkata", "Australia/Sydney"]) {
      const local = "2026-10-23T23:59";
      const instant = zonedToInstant(local, zone) as string;
      expect(instantToZoned(instant, zone)).toBe(local);
    }
  });

  it("refuses an unreadable instant", () => {
    expect(instantToZoned("not a date", "UTC")).toBeNull();
  });
});

describe("startOfDayInstant", () => {
  it("is the instant a window opens: 00:00 of its first date at the venue", () => {
    expect(startOfDayInstant("2026-10-20", "America/Chicago")).toBe("2026-10-20T05:00:00.000Z");
  });
});

describe("nowInZone and isValidTimeZone", () => {
  it("formats a given moment in the zone", () => {
    expect(nowInZone("Asia/Tokyo", new Date("2026-10-07T15:00:00Z"))).toBe("2026-10-08T00:00");
  });

  it("knows a zone from a typo", () => {
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("America/Chicgo")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
