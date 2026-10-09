import { describe, expect, it } from "vitest";

import { countIsoDays, isoDatesBetween, monthLabel, shiftIsoDate, shortDateLabel } from "./iso-date";

describe("isoDatesBetween", () => {
  it("lists every date of a window, inclusive", () => {
    expect(isoDatesBetween("2030-10-29", "2030-11-02")).toEqual([
      "2030-10-29",
      "2030-10-30",
      "2030-10-31",
      "2030-11-01",
      "2030-11-02",
    ]);
    expect(isoDatesBetween("2030-10-20", "2030-10-20")).toEqual(["2030-10-20"]);
  });

  it("has no length limit", () => {
    expect(isoDatesBetween("2030-01-01", "2030-12-31")).toHaveLength(365);
  });

  it("is empty for a backwards or unreadable range, rather than throwing", () => {
    expect(isoDatesBetween("2030-10-30", "2030-10-20")).toEqual([]);
    expect(isoDatesBetween("", "")).toEqual([]);
    expect(isoDatesBetween("nope", "2030-10-20")).toEqual([]);
  });
});

describe("shiftIsoDate and countIsoDays", () => {
  it("do not drift across a daylight-saving change", () => {
    expect(shiftIsoDate("2030-11-02", 1)).toBe("2030-11-03");
    expect(shiftIsoDate("2030-03-09", 1)).toBe("2030-03-10");
    expect(countIsoDays("2030-11-01", "2030-11-05")).toBe(5);
  });

  it("stay blank for a date they cannot read", () => {
    expect(shiftIsoDate("", 1)).toBe("");
    expect(shiftIsoDate("2030-13-45", 1)).toBe("");
  });
});

describe("labels", () => {
  it("read a date the same everywhere, whatever the viewer's zone", () => {
    expect(monthLabel("2030-10-20")).toMatch(/October/);
    expect(shortDateLabel("2030-10-20")).toMatch(/Oct/);
    expect(shortDateLabel("2030-10-20")).toMatch(/20/);
  });
});
