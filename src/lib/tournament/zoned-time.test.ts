import { describe, expect, it } from "vitest";

import { dayWindowBounds } from "./scheduling/day-plan";
import {
  dateKeyInZone,
  instantToZoned,
  isValidTimeZone,
  nowInZone,
  startOfDayInstant,
  venueZoneOf,
  wallClockMs,
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

/**
 * The planners' conversion. A day's window is the venue's clock, as the database reads
 * `date + start_time AT TIME ZONE venue_timezone`; it used to be read in the process's zone, so a
 * host away from the venue - or CI on UTC - planned every match hours off the server's window.
 * Each case states its expected instant in UTC, so it passes in any process zone.
 */
describe("wallClockMs", () => {
  it("reads a day's time on the venue's clock, whatever the process's zone", () => {
    expect(new Date(wallClockMs("2026-11-05", "09:00:00", "America/Chicago")).toISOString()).toBe(
      "2026-11-05T15:00:00.000Z",
    );
    expect(new Date(wallClockMs("2026-11-05", "09:00", "Asia/Ho_Chi_Minh")).toISOString()).toBe(
      "2026-11-05T02:00:00.000Z",
    );
    expect(new Date(wallClockMs("2026-11-05", "09:00:30", "UTC")).toISOString()).toBe(
      "2026-11-05T09:00:30.000Z",
    );
  });

  it("follows daylight saving on the days the clocks change", () => {
    // Chicago springs forward on 8 March 2026 (CST to CDT) and falls back on 1 November.
    expect(new Date(wallClockMs("2026-03-08", "09:00", "America/Chicago")).toISOString()).toBe(
      "2026-03-08T14:00:00.000Z",
    );
    expect(new Date(wallClockMs("2026-03-07", "09:00", "America/Chicago")).toISOString()).toBe(
      "2026-03-07T15:00:00.000Z",
    );
    expect(new Date(wallClockMs("2026-11-01", "09:00", "America/Chicago")).toISOString()).toBe(
      "2026-11-01T15:00:00.000Z",
    );
    expect(new Date(wallClockMs("2026-10-31", "09:00", "America/Chicago")).toISOString()).toBe(
      "2026-10-31T14:00:00.000Z",
    );
  });

  it("is not a number for a malformed date or time, and reads an unknown zone as UTC", () => {
    expect(wallClockMs("not a date", "09:00", "UTC")).toBeNaN();
    expect(wallClockMs("2026-11-05", "nine", "UTC")).toBeNaN();
    expect(new Date(wallClockMs("2026-11-05", "09:00", "Mars/Olympus")).toISOString()).toBe(
      "2026-11-05T09:00:00.000Z",
    );
  });
});

describe("dateKeyInZone", () => {
  it("names the venue's calendar day, which can differ from UTC's", () => {
    // 03:00 UTC on the 6th is still the evening of the 5th in Chicago.
    const ms = Date.parse("2026-11-06T03:00:00Z");
    expect(dateKeyInZone(ms, "America/Chicago")).toBe("2026-11-05");
    expect(dateKeyInZone(ms, "UTC")).toBe("2026-11-06");
    expect(dateKeyInZone(ms, "Asia/Ho_Chi_Minh")).toBe("2026-11-06");
  });
});

describe("dayWindowBounds", () => {
  it("opens and closes a day on the venue's clock", () => {
    const day = {
      id: "d1",
      tournament_id: "t1",
      day_number: 1,
      date: "2026-11-05",
      start_time: "09:00:00",
      end_time: "18:00:00",
      created_at: "2026-11-01T00:00:00Z",
    };
    const { start, end } = dayWindowBounds(day, "America/Chicago");
    expect(new Date(start).toISOString()).toBe("2026-11-05T15:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });
});

describe("venueZoneOf", () => {
  it("takes the venue's zone once the tournament has loaded", () => {
    expect(venueZoneOf({ venue_timezone: "Asia/Ho_Chi_Minh" })).toBe("Asia/Ho_Chi_Minh");
  });

  it("stands in with the browser's zone while there is no tournament, or a bad zone", () => {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(venueZoneOf(null)).toBe(own);
    expect(venueZoneOf({ venue_timezone: "Mars/Olympus" })).toBe(own);
  });
});
