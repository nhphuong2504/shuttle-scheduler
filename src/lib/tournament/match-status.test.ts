import { describe, expect, it } from "vitest";

import {
  BYE_NOTE,
  displayStateFor,
  isByeMatch,
  MATCH_DISPLAY_LABEL,
  MATCH_DISPLAY_STATES,
  MATCH_DISPLAY_TIER,
  PERSISTED_MATCH_STATUSES,
  TIER4_DISPLAY_STATES,
  VESTIGIAL_MATCH_STATUSES,
} from "@/lib/tournament/match-status";

const CHECK_CONSTRAINT = ["scheduled", "in-progress", "reported", "walkover", "void"];

describe("the persisted status vocabulary", () => {
  it("matches the CHECK constraints on the match tables", () => {
    // Transcribed from the migrations, not inferred. Four tables carry a status
    // CHECK: pool_matches and placement_matches permit exactly these five, and
    // draw_matches/tier_draw_matches permit these plus the vestigial "bye" handled below.
    // If a migration widens a constraint without widening this list, every display
    // table silently loses the new value and it renders as an unrecognised string.
    expect([...PERSISTED_MATCH_STATUSES].sort()).toEqual([...CHECK_CONSTRAINT].sort());
  });

  it("maps every persisted status to a display state that exists", () => {
    for (const status of PERSISTED_MATCH_STATUSES) {
      const display = displayStateFor(status);
      expect(display, `${status} is unrepresentable`).not.toBeNull();
      expect(MATCH_DISPLAY_STATES).toContain(display);

      // Label and tier are what make it renderable at all. A missing label renders
      // `undefined`; a missing tier falls into the chip branch by accident.
      expect(MATCH_DISPLAY_LABEL[display!]).toBeTruthy();
      expect([1, 2, 3, 4]).toContain(MATCH_DISPLAY_TIER[display!]);
    }
  });

  it("gives every display state exactly one label, so aliases cannot collide", () => {
    // Two statuses renaming onto the same display state would make them
    // indistinguishable on screen while still being distinct in the database.
    expect(new Set(Object.values(MATCH_DISPLAY_LABEL)).size).toBe(MATCH_DISPLAY_STATES.length);

    const displays = PERSISTED_MATCH_STATUSES.map((s) => displayStateFor(s));
    expect(new Set(displays).size).toBe(displays.length);
  });

  it("derives the tier-4 set from the tier map rather than listing it twice", () => {
    // The property that matters: tier 4 is ink-only and has no chip token, so this
    // list and the token check must agree. Deriving it means they cannot disagree.
    expect([...TIER4_DISPLAY_STATES].sort()).toEqual(["completed", "walkover"]);
    for (const display of TIER4_DISPLAY_STATES) {
      expect(MATCH_DISPLAY_TIER[display]).toBe(4);
    }
    for (const display of MATCH_DISPLAY_STATES) {
      if (MATCH_DISPLAY_TIER[display] === 4) continue;
      expect(TIER4_DISPLAY_STATES).not.toContain(display);
    }
  });

  it("is case-sensitive, so a differently-cased value is not silently accepted", () => {
    expect(displayStateFor("In-Progress")).toBeNull();
    expect(displayStateFor("void ")).toBeNull();
  });

  it("returns null for anything the schema cannot hold", () => {
    expect(displayStateFor("")).toBeNull();
    expect(displayStateFor("disputed")).toBeNull();
    expect(displayStateFor("paused")).toBeNull();
  });
});

describe("bye is a draw condition, not a status", () => {
  it("is not part of the display vocabulary", () => {
    // The schema permits `status = 'bye'` on draw_matches and tier_draw_matches, so it is
    // named - but it is not a display state, because a bye is not a match that
    // happened. Adding it to the vocabulary would invent a status the generator
    // never writes.
    expect([...VESTIGIAL_MATCH_STATUSES]).toEqual(["bye"]);
    expect(MATCH_DISPLAY_STATES).not.toContain("bye");
    expect(PERSISTED_MATCH_STATUSES).not.toContain("bye");
    expect(displayStateFor("bye")).toBeNull();
  });

  it("detects the row the generator actually writes", () => {
    // The real shape, from actions.ts: an automatic advance is stored as
    // status "reported" with is_bye true and note "Bye" - never status "bye".
    const generated = { status: "reported", is_bye: true, note: BYE_NOTE, winner_id: "e1" };
    expect(isByeMatch(generated)).toBe(true);
    expect(displayStateFor(generated.status)).toBe("completed");
  });

  it("accepts either signal, because different pages checked different ones", () => {
    // `note` alone was the older marker and `is_bye` the newer one; the app checked
    // one or the other depending on the file, so a row carrying only one of them was
    // drawn differently on two pages. Reading either is a superset of both.
    expect(isByeMatch({ note: BYE_NOTE })).toBe(true);
    expect(isByeMatch({ is_bye: true })).toBe(true);
    expect(isByeMatch({ is_bye: true, note: null })).toBe(true);
  });

  it("does not treat a played match as a bye", () => {
    expect(isByeMatch({ is_bye: false, note: null })).toBe(false);
    expect(isByeMatch({ is_bye: false, note: "" })).toBe(false);
    // A note that merely mentions a bye is not a bye. The marker is exact.
    expect(isByeMatch({ note: "bye" })).toBe(false);
    expect(isByeMatch({ note: "Bye bye" })).toBe(false);
  });

  it("tolerates the null fields rows arrive with", () => {
    expect(isByeMatch({ is_bye: null, note: null })).toBe(false);
    expect(isByeMatch({})).toBe(false);
  });
});
