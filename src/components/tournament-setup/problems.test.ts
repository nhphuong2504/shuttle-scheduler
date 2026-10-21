import { describe, expect, it } from "vitest";

import {
  effectiveRegistration,
  localChecks,
  problemsForStep,
  registrationProblems,
  suggestedRegistrationClose,
} from "./problems";
import { defaultForm, type DraftForm } from "./types";

/** 7 Oct 2026, 14:03 in Chicago (UTC-5): a fixed "now" for every test. */
const NOW = new Date("2026-10-07T19:03:00Z");

function filled(overrides: Partial<DraftForm> = {}): DraftForm {
  const base = defaultForm();
  return {
    ...base,
    basics: { ...base.basics, name: "City Open", venueTimezone: "America/Chicago" },
    startsOn: "2026-10-20",
    endsOn: "2026-10-30",
    events: [
      { code: "MS", name: "Men's Singles", entryType: "individual", gender: "men", maxEntries: null },
    ],
    ...overrides,
  };
}

describe("suggestedRegistrationClose", () => {
  it("is the end of the day before the tournament", () => {
    expect(suggestedRegistrationClose("2026-10-20")).toBe("2026-10-19T23:59");
    expect(suggestedRegistrationClose("2026-11-01")).toBe("2026-10-31T23:59");
  });

  it("is blank while there is no first date", () => {
    expect(suggestedRegistrationClose("")).toBe("");
  });
});

describe("effectiveRegistration", () => {
  it("fills an empty opening time with now at the venue, and an empty deadline with the suggestion", () => {
    expect(effectiveRegistration(filled(), NOW)).toEqual({
      opensAt: "2026-10-07T14:03",
      closesAt: "2026-10-19T23:59",
    });
  });

  it("leaves what the host typed alone", () => {
    const form = filled({
      registration: { enabled: true, opensAt: "2026-10-08T09:00", closesAt: "2026-10-18T12:00" },
    });
    expect(effectiveRegistration(form, NOW)).toEqual({
      opensAt: "2026-10-08T09:00",
      closesAt: "2026-10-18T12:00",
    });
  });
});

describe("registrationProblems", () => {
  it("has none for the defaults of a tournament that is weeks away", () => {
    expect(registrationProblems(filled(), NOW)).toEqual([]);
  });

  it("has none when registration is off, whatever the times say", () => {
    const form = filled({
      registration: { enabled: false, opensAt: "2026-12-01T00:00", closesAt: "2020-01-01T00:00" },
    });
    expect(registrationProblems(form, NOW)).toEqual([]);
  });

  it("requires the deadline to be after the opening", () => {
    const form = filled({
      registration: { enabled: true, opensAt: "2026-10-15T09:00", closesAt: "2026-10-14T09:00" },
    });
    expect(registrationProblems(form, NOW)).toContain("Registration must close after it opens.");
  });

  it("requires the deadline to be before the first day starts, not on it", () => {
    const onTheDay = filled({
      registration: { enabled: true, opensAt: "2026-10-08T09:00", closesAt: "2026-10-20T08:00" },
    });
    expect(registrationProblems(onTheDay, NOW).join(" ")).toMatch(
      /must close before the tournament starts \(2026-10-20, 00:00\)/,
    );
    const atMidnight = filled({
      registration: { enabled: true, opensAt: "2026-10-08T09:00", closesAt: "2026-10-20T00:00" },
    });
    // 00:00 itself is the last allowed instant: the deadline may equal the start.
    expect(registrationProblems(atMidnight, NOW)).toEqual([]);
  });

  it("is told when the tournament starts today and the suggested deadline has already passed", () => {
    const form = filled({ startsOn: "2026-10-07", endsOn: "2026-10-09" });
    expect(registrationProblems(form, NOW)).toContain("Registration must close after it opens.");
  });

  it("is fine when the tournament starts tomorrow: the default deadline is tonight", () => {
    const form = filled({ startsOn: "2026-10-08", endsOn: "2026-10-09" });
    expect(registrationProblems(form, NOW)).toEqual([]);
  });

  it("moves with the first date, so changing it on step 1 changes what step 2 says", () => {
    const early = filled({
      registration: { enabled: true, opensAt: "2026-10-08T09:00", closesAt: "2026-10-19T23:59" },
      startsOn: "2026-10-15",
      endsOn: "2026-10-16",
    });
    expect(registrationProblems(early, NOW).join(" ")).toMatch(/2026-10-15/);
  });
});

describe("problemsForStep", () => {
  it("asks for a name, a valid timezone and both dates on the first step", () => {
    const empty = problemsForStep("details", defaultForm(), NOW);
    expect(empty).toContain("Give the tournament a name.");
    expect(empty).toContain("Pick the first day.");
    expect(problemsForStep("details", filled(), NOW)).toEqual([]);
  });

  it("asks for the last date separately from the first", () => {
    expect(problemsForStep("details", filled({ endsOn: "" }), NOW)).toEqual(["Pick the last day."]);
  });

  it("refuses a window that ends before it starts", () => {
    expect(problemsForStep("details", filled({ startsOn: "2026-10-30", endsOn: "2026-10-20" }), NOW)).toEqual([
      "The tournament cannot end before it starts.",
    ]);
  });

  it("accepts a long window: its length is not a limit", () => {
    expect(problemsForStep("details", filled({ startsOn: "2026-10-20", endsOn: "2027-03-01" }), NOW)).toEqual([]);
  });

  it("refuses a timezone the runtime does not know", () => {
    const form = filled();
    form.basics.venueTimezone = "Mars/Olympus";
    expect(problemsForStep("details", form, NOW)).toEqual(["Choose a timezone."]);
  });

  it("asks for an event, and for a sensible cap", () => {
    expect(problemsForStep("events", filled({ events: [] }), NOW)).toContain("Add at least one event.");
    const capped = filled();
    capped.events = [{ ...capped.events[0]!, maxEntries: 1 }];
    expect(problemsForStep("events", capped, NOW)).toContain(
      "MS needs an entry cap of 2 or more, or no cap.",
    );
  });

  it("refuses a cap that is not a whole number", () => {
    const form = filled();
    form.events = [{ ...form.events[0]!, maxEntries: Number.NaN }];
    expect(problemsForStep("events", form, NOW)).toContain(
      "MS needs an entry cap of 2 or more, or no cap.",
    );
    form.events = [{ ...form.events[0]!, maxEntries: 2.5 }];
    expect(problemsForStep("events", form, NOW)).toContain(
      "MS needs an entry cap of 2 or more, or no cap.",
    );
  });

  it("puts the registration problems on the details step, beside the dates they depend on", () => {
    const form = filled({
      registration: { enabled: true, opensAt: "2026-10-08T09:00", closesAt: "2026-10-25T09:00" },
    });
    expect(problemsForStep("details", form, NOW).join(" ")).toMatch(/must close before the tournament starts/);
    expect(problemsForStep("events", form, NOW)).toEqual([]);
  });

  it("has nothing to say about the structure or the review", () => {
    expect(problemsForStep("structure", defaultForm(), NOW)).toEqual([]);
    expect(problemsForStep("review", defaultForm(), NOW)).toEqual([]);
  });
});

describe("localChecks", () => {
  it("passes for a complete form", () => {
    expect(localChecks(filled(), NOW).every((check) => check.ok)).toBe(true);
  });

  it("uses the database's ids for the questions the database also asks", () => {
    expect(localChecks(filled(), NOW).map((check) => check.id)).toEqual([
      "basics",
      "timezone",
      "window",
      "categories",
      "category_caps",
      "registration",
    ]);
  });

  it("leaves the registration check out when registration is off", () => {
    const off = filled({ registration: { enabled: false, opensAt: "", closesAt: "" } });
    expect(localChecks(off, NOW).map((check) => check.id)).not.toContain("registration");
  });

  it("names what is wrong, not only that something is", () => {
    const checks = localChecks(defaultForm(), NOW);
    const window = checks.find((check) => check.id === "window");
    expect(window?.ok).toBe(false);
    expect(window?.detail).toBe("Pick the first day.");
    expect(checks.find((check) => check.id === "categories")?.detail).toBe("Add at least one event.");
  });
});
