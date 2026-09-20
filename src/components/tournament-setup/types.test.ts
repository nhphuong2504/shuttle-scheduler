import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAY_END,
  DEFAULT_DAY_START,
  MAX_TOURNAMENT_DAYS,
  buildDayRange,
  countIsoDays,
  dateRangeLabel,
  defaultForm,
  shiftIsoDate,
  todayIso,
} from "./types";

describe("buildDayRange", () => {
  it("makes one row per date, inclusive of both ends", () => {
    const days = buildDayRange("2026-09-18", "2026-09-20");
    expect(days.map((day) => day.date)).toEqual(["2026-09-18", "2026-09-19", "2026-09-20"]);
  });

  it("treats a single date as a one-day tournament", () => {
    const days = buildDayRange("2026-09-18", "2026-09-18");
    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe("2026-09-18");
  });

  it("falls back to the start date when no end is given", () => {
    expect(buildDayRange("2026-09-18", "").map((day) => day.date)).toEqual(["2026-09-18"]);
  });

  it("leaves the hours and court list to the first build", () => {
    // Setup only decides which dates run. Courts, hours and breaks are configured
    // later, where the courts exist, so a fresh day carries only neutral defaults.
    const [day] = buildDayRange("2026-09-18", "2026-09-18");
    expect(day?.startTime).toBe(DEFAULT_DAY_START);
    expect(day?.endTime).toBe(DEFAULT_DAY_END);
    expect(day?.courts).toEqual([]);
    expect(day?.breaks).toEqual([]);
  });

  it("rejects a range that runs backwards", () => {
    expect(() => buildDayRange("2026-09-20", "2026-09-18")).toThrow(/end date cannot be before/i);
  });

  it("rejects a range longer than the database would accept", () => {
    // `save_tournament_days` refuses more than MAX_TOURNAMENT_DAYS rows, so the
    // picker must not be able to build a payload that could never be saved.
    expect(() => buildDayRange("2026-09-01", "2026-09-30")).toThrow(
      new RegExp(`at most ${MAX_TOURNAMENT_DAYS} days`),
    );
  });

  it("allows exactly the maximum", () => {
    const days = buildDayRange("2026-09-01", shiftIsoDate("2026-09-01", MAX_TOURNAMENT_DAYS - 1));
    expect(days).toHaveLength(MAX_TOURNAMENT_DAYS);
  });

  it("returns nothing when there is no start date", () => {
    expect(buildDayRange("", "2026-09-18")).toEqual([]);
  });

  it("crosses a month and a year boundary without drifting", () => {
    expect(buildDayRange("2026-12-31", "2027-01-02").map((day) => day.date)).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });
});

describe("date helpers", () => {
  it("counts inclusively", () => {
    expect(countIsoDays("2026-09-18", "2026-09-18")).toBe(1);
    expect(countIsoDays("2026-09-18", "2026-09-20")).toBe(3);
  });

  it("shifts by whole days", () => {
    expect(shiftIsoDate("2026-09-18", 0)).toBe("2026-09-18");
    expect(shiftIsoDate("2026-09-18", 6)).toBe("2026-09-24");
  });

  it("reads today as a plain date", () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("dateRangeLabel", () => {
  it("collapses a single day and spells out a range", () => {
    expect(dateRangeLabel(buildDayRange("2026-09-18", "2026-09-18"))).toBe("2026-09-18");
    expect(dateRangeLabel(buildDayRange("2026-09-18", "2026-09-20"))).toBe(
      "2026-09-18 to 2026-09-20",
    );
  });

  it("says so when there are no days", () => {
    expect(dateRangeLabel([])).toBe("No days yet");
  });
});

describe("defaultForm", () => {
  it("starts on a single day and carries no match rules", () => {
    const form = defaultForm();
    expect(form.days).toHaveLength(1);
    // Scoring, durations and rest gaps are set on the Schedule page, so the wizard
    // form no longer carries them at all.
    expect(form).not.toHaveProperty("rules");
  });
});
