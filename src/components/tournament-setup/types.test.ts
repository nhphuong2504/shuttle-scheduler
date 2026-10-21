import { describe, expect, it } from "vitest";

import {
  SETUP_STEPS,
  countIsoDays,
  defaultForm,
  setupSteps,
  shiftIsoDate,
  stepForCheck,
  todayIso,
  windowLabel,
} from "./types";

describe("countIsoDays", () => {
  it("counts inclusively", () => {
    expect(countIsoDays("2026-09-18", "2026-09-18")).toBe(1);
    expect(countIsoDays("2026-09-18", "2026-09-20")).toBe(3);
  });

  it("is not capped: a window is not the number of days played", () => {
    expect(countIsoDays("2026-10-20", "2026-10-30")).toBe(11);
    expect(countIsoDays("2026-01-01", "2026-12-31")).toBe(365);
  });
});

describe("shiftIsoDate", () => {
  it("moves by whole days in either direction", () => {
    expect(shiftIsoDate("2026-09-18", 0)).toBe("2026-09-18");
    expect(shiftIsoDate("2026-09-18", 6)).toBe("2026-09-24");
    expect(shiftIsoDate("2026-10-01", -1)).toBe("2026-09-30");
  });

  it("crosses month and year ends", () => {
    expect(shiftIsoDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftIsoDate("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("todayIso", () => {
  it("is a calendar date", () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("windowLabel", () => {
  it("names one day by its date and a window by its two", () => {
    expect(windowLabel("2026-09-18", "2026-09-18")).toBe("2026-09-18");
    expect(windowLabel("2026-09-18", "")).toBe("2026-09-18");
    expect(windowLabel("2026-09-18", "2026-09-20")).toBe("2026-09-18 to 2026-09-20");
  });

  it("says so when there is no window yet", () => {
    expect(windowLabel("", "")).toBe("No dates yet");
  });
});

describe("defaultForm", () => {
  it("starts with no dates, so the host has to choose them", () => {
    const form = defaultForm();
    expect(form.startsOn).toBe("");
    expect(form.endsOn).toBe("");
    expect(form.events).toEqual([]);
  });

  it("offers registration by default, with its times left to the suggestion", () => {
    expect(defaultForm().registration).toEqual({ enabled: true, opensAt: "", closesAt: "" });
  });

  it("holds no playing days: those are chosen when the schedule is built", () => {
    expect("days" in defaultForm()).toBe(false);
  });
});

describe("the steps", () => {
  it("names the last one for what it does to the tournament", () => {
    expect(SETUP_STEPS.at(-1)?.label).toBe("Review and create");
    expect(setupSteps(false).at(-1)?.label).toBe("Review and create");
    expect(setupSteps(true).at(-1)?.label).toBe("Review");
  });
});

describe("stepForCheck", () => {
  it("sends each check to the step that fixes it", () => {
    expect(stepForCheck("basics")).toBe("details");
    expect(stepForCheck("timezone")).toBe("details");
    expect(stepForCheck("window")).toBe("details");
    expect(stepForCheck("categories")).toBe("events");
    expect(stepForCheck("category_caps")).toBe("events");
    expect(stepForCheck("registration")).toBe("details");
  });

  it("sends a check it does not know nowhere, rather than guessing", () => {
    expect(stepForCheck("days")).toBeNull();
    expect(stepForCheck("anything-else")).toBeNull();
  });
});
