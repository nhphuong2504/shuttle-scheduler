import { describe, expect, it } from "vitest";

import { dateTimeLabel, dayDateLabel, timeLabel } from "./format";

describe("dayDateLabel", () => {
  /**
   * The whole reason this helper exists rather than callers doing `new Date(date)`.
   *
   * A bare `YYYY-MM-DD` is parsed as UTC midnight, so west of Greenwich it reads as
   * the previous day — day one of a tournament showing yesterday's date. Asserting
   * the day number is what catches that, and it holds in any runner timezone because
   * the helper parses at local midnight.
   */
  it("shows the date it was given, not the day before", () => {
    expect(dayDateLabel("2026-09-17")).toContain("17");
    expect(dayDateLabel("2026-09-17")).not.toContain("16");
  });

  it("handles the first of a month without borrowing from the previous one", () => {
    expect(dayDateLabel("2026-10-01")).toContain("1");
    expect(dayDateLabel("2026-10-01")).not.toContain("Sep");
  });

  it("returns a value it cannot parse unchanged, rather than Invalid Date", () => {
    // A malformed row should be visible for what it is instead of blanking a heading.
    expect(dayDateLabel("not-a-date")).toBe("not-a-date");
    expect(dayDateLabel("")).toBe("");
  });
});

describe("timeLabel", () => {
  it("falls back to the raw value for a time it cannot parse", () => {
    expect(timeLabel(null)).toBe("—");
    expect(timeLabel(undefined)).toBe("—");
  });

  it("renders a time as a zero-padded 24 hour clock", () => {
    expect(timeLabel("2026-09-17T09:05:00")).toBe("09:05");
  });
});

describe("dateTimeLabel", () => {
  /**
   * The finish forecast is an instant read across a day boundary — an overrun finishes after
   * midnight — so a bare time would be ambiguous. Unlike `dayDateLabel` this takes a real
   * instant, because a forecast is never a bare `YYYY-MM-DD`.
   */
  it("includes both the date and the time", () => {
    const label = dateTimeLabel("2026-09-18T00:20:00");
    expect(label).toContain("18");
    expect(label).toContain("00:20");
  });

  it("accepts an instant as a Date, a string or milliseconds", () => {
    const at = new Date("2026-09-17T18:20:00").getTime();
    expect(dateTimeLabel(at)).toBe(dateTimeLabel(new Date(at)));
    expect(dateTimeLabel(new Date(at).toISOString())).toBe(dateTimeLabel(new Date(at)));
  });

  it("degrades to a dash rather than Invalid Date", () => {
    expect(dateTimeLabel(null)).toBe("—");
    expect(dateTimeLabel("not-a-date")).toBe("—");
  });
});
