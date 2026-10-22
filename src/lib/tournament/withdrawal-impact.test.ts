import { describe, expect, it } from "vitest";

import { withdrawalImpact, withdrawalWarning } from "./withdrawal-impact";

const rows = <T>(value: unknown[]) => value as unknown as T[];

const entrants = rows<never>([
  { id: "e1", team_id: "t1", excluded: false },
  { id: "e2", team_id: "t2", excluded: false },
  { id: "e3", team_id: "t3", excluded: true },
]);

const placementMatches = rows<never>([
  { entrant_a_id: "e1", entrant_b_id: "e2", status: "reported", scheduled_time: "2026-12-01T09:00Z" },
  { entrant_a_id: "e1", entrant_b_id: "e2", status: "scheduled", scheduled_time: "2026-12-01T10:00Z" },
  { entrant_a_id: "e1", entrant_b_id: "e2", status: "scheduled", scheduled_time: null },
  { entrant_a_id: "e1", entrant_b_id: "e2", status: "in-progress", scheduled_time: "2026-12-01T11:00Z" },
  { entrant_a_id: "e2", entrant_b_id: "e2", status: "scheduled", scheduled_time: null },
  { entrant_a_id: "e1", entrant_b_id: "e2", status: "void", scheduled_time: null },
]);

const tierMatches = rows<never>([
  { entrant_a_id: "e1", entrant_b_id: "e2", status: "scheduled", scheduled_time: "2026-12-02T09:00Z", is_bye: false },
  { entrant_a_id: "e1", entrant_b_id: null, status: "scheduled", scheduled_time: null, is_bye: true },
]);

const impact = (teamId: string) =>
  withdrawalImpact({ teamId, entrants: entrants as never, placementMatches: placementMatches as never, tierMatches: tierMatches as never });

describe("withdrawalImpact", () => {
  it("counts a team's matches by what became of them, skipping voids and byes", () => {
    expect(impact("t1")).toEqual({
      entrantId: "e1",
      inProgress: 1,
      unplayed: 3,
      scheduled: 2,
      decided: 1,
      stillInField: true,
    });
  });

  it("finds nothing for a team that was never synced into placement", () => {
    expect(impact("nobody")).toMatchObject({ entrantId: null, unplayed: 0, stillInField: false });
  });

  it("says a waived entrant is already out of the field", () => {
    expect(impact("t3").stillInField).toBe(false);
  });
});

describe("withdrawalWarning", () => {
  it("is silent when nothing is scheduled or played", () => {
    expect(withdrawalWarning("Cy", impact("t3"))).toBeNull();
    expect(withdrawalWarning("Nobody", impact("nobody"))).toBeNull();
  });

  it("names the matches that stay and points at the Desk's walkover", () => {
    const text = withdrawalWarning("Ana", impact("t1")) ?? "";
    expect(text).toMatch(/A match is being played now/);
    expect(text).toMatch(/3 unplayed matches stay in the draw, 2 of them already on the schedule/);
    expect(text).toMatch(/1 recorded result is kept/);
    expect(text).toMatch(/walkover on the Desk/);
  });
});
