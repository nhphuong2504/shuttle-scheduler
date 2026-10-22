import { describe, expect, it } from "vitest";

import { organiserNextStep, type NextStepInput } from "./next-step";

/** An upcoming tournament that is fully ready to play, so each test breaks one thing. */
function input(over: Partial<NextStepInput> = {}): NextStepInput {
  return {
    status: "upcoming",
    phase: "upcoming",
    registrationState: "closed",
    pendingRequests: 0,
    activeEntrants: 8,
    unseededEntrants: 0,
    placementMatches: 12,
    scheduledPlacementMatches: 12,
    ...over,
  };
}

const stage = (over: Partial<NextStepInput>) => organiserNextStep(input(over))?.stage;

describe("organiserNextStep", () => {
  it("asks for nothing once the tournament is completed", () => {
    expect(organiserNextStep(input({ status: "completed", phase: "completed" }))).toBeNull();
  });

  it("puts waiting requests first, before anything else is missing", () => {
    expect(stage({ pendingRequests: 3, activeEntrants: 0, registrationState: "open" })).toBe(
      "review_requests",
    );
    expect(organiserNextStep(input({ pendingRequests: 1 }))?.target).toBe("registrations");
  });

  it("says registration is still open rather than moving on to seeding", () => {
    expect(stage({ registrationState: "open", unseededEntrants: 8 })).toBe("registration_open");
    expect(stage({ registrationState: "opens_soon" })).toBe("registration_open");
  });

  it("asks for entries when the roster is empty", () => {
    expect(stage({ activeEntrants: 0 })).toBe("add_entries");
  });

  it("asks for seeds while any entrant is unseeded", () => {
    const step = organiserNextStep(input({ unseededEntrants: 1 }));
    expect(step?.stage).toBe("seed");
    expect(step?.target).toBe("placement");
  });

  it("asks for a schedule when none exists or some matches have no slot", () => {
    expect(stage({ placementMatches: 0, scheduledPlacementMatches: 0 })).toBe("schedule");
    expect(stage({ scheduledPlacementMatches: 11 })).toBe("schedule");
  });

  it("is ready to play when seeded and fully scheduled", () => {
    const step = organiserNextStep(input());
    expect(step?.stage).toBe("run");
    expect(step?.target).toBe("desk");
  });

  it("reminds that the first day has begun when nothing has started", () => {
    expect(organiserNextStep(input({ phase: "not_started" }))?.detail).toMatch(/first day/);
  });

  it("points a running tournament at the Desk", () => {
    const step = organiserNextStep(input({ status: "in_progress", phase: "live" }));
    expect(step?.stage).toBe("run");
    expect(step?.target).toBe("desk");
  });

  it("offers Complete once the last day has passed", () => {
    const step = organiserNextStep(input({ status: "in_progress", phase: "past_last_day" }));
    expect(step?.stage).toBe("complete");
    expect(step?.target).toEqual({ kind: "complete" });
  });
});
