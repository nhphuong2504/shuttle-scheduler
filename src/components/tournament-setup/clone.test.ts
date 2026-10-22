import { describe, expect, it } from "vitest";

import { cloneDraft, nextName, oneYearOn } from "./clone";

describe("nextName", () => {
  it("moves the year on, or marks a copy", () => {
    expect(nextName("City Open 2026")).toBe("City Open 2027");
    expect(nextName("  Club Night ")).toBe("Club Night (copy)");
  });
});

describe("oneYearOn", () => {
  it("keeps the calendar date, sends 29 February to 1 March, and leaves blank blank", () => {
    expect(oneYearOn("2026-12-01")).toBe("2027-12-01");
    expect(oneYearOn("2028-02-29")).toBe("2029-03-01");
    expect(oneYearOn("")).toBe("");
  });
});

describe("cloneDraft", () => {
  const tournament = {
    name: "City Open 2026",
    notes: "Bring a racket",
    venue_name: "Hall A",
    venue_address: "1 Main St",
    venue_timezone: "America/Chicago",
    organizer_name: "Ana",
    organizer_email: "ana@example.test",
    organizer_phone: null,
    starts_on: "2026-12-01",
    ends_on: "2026-12-03",
    max_categories_per_player: 2,
    registration_opens_at: "2026-09-01T00:00:00Z",
    registration_closes_at: "2026-11-30T23:59:00Z",
  };
  const categories = [
    { code: "MS", name: "Men's Singles", entry_type: "individual", gender: "men", sort_order: 1, active: true, max_entries: 16 },
  ];
  const form = cloneDraft(tournament as never, categories as never);

  it("keeps the venue, organiser, events and caps", () => {
    expect(form.basics.venueName).toBe("Hall A");
    expect(form.basics.organizerEmail).toBe("ana@example.test");
    expect(form.maxCategoriesPerPlayer).toBe(2);
    expect(form.events.map((event) => event.code)).toEqual(["MS"]);
    expect(form.events[0]?.maxEntries).toBe(16);
  });

  it("moves the name and dates a year on and resets the registration window to its defaults", () => {
    expect(form.basics.name).toBe("City Open 2027");
    expect(form.startsOn).toBe("2027-12-01");
    expect(form.endsOn).toBe("2027-12-03");
    expect(form.registration).toEqual({ enabled: true, opensAt: "", closesAt: "" });
  });
});
