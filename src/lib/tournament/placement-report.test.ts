import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The client is stubbed so the report payload can be read without a database.
 *
 * What matters here is the *shape* of the argument object: the finish offset must be
 * absent when it is zero, because the database's default is what keeps an old caller
 * and a pre-set `ended_at` fixture on the old path. Sending an explicit zero would be
 * the same value to the database but a different request to every mock that pins one.
 */
const mocks = vi.hoisted(() => {
  const rpc = vi.fn(async (): Promise<{ data: unknown; error: { message: string } | null }> => ({
    data: null,
    error: null,
  }));
  // `placementScheduleSnapshot` reads two tables with a select and a two-`eq` chain.
  // The rows are irrelevant to this file - only that the chain resolves.
  const secondEq = vi.fn(async () => ({ data: [], error: null }));
  const firstEq = vi.fn(() => ({ eq: secondEq }));
  const select = vi.fn(() => ({ eq: firstEq }));
  const from = vi.fn(() => ({ select }));
  return { rpc, from };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
}));

import {
  addPlacementEntrant,
  reassignCourtMatches,
  reportPlacementMatch,
  reportTierDrawMatch,
  shiftTournamentDays,
  withdrawPlacementTeam,
} from "./placement-actions";

beforeEach(() => {
  mocks.rpc.mockClear();
});

describe("the report RPC payload", () => {
  it("omits the finish offset for a live report, keeping the old two-key body", async () => {
    await reportPlacementMatch("m1", [{ a: 21, b: 10 }], "t1");
    expect(mocks.rpc).toHaveBeenCalledWith("report_placement_result", {
      p_match_id: "m1",
      p_games: [{ a: 21, b: 10 }],
    });
  });

  it("omits it for an explicit zero too, rather than sending a meaningless argument", async () => {
    await reportTierDrawMatch("m2", [{ a: 21, b: 10 }], "t1", 0);
    expect(mocks.rpc).toHaveBeenCalledWith("report_tier_draw_result", {
      p_match_id: "m2",
      p_games: [{ a: 21, b: 10 }],
    });
  });

  it("sends the offset under its own name when the result was entered late", async () => {
    await reportPlacementMatch("m3", [{ a: 21, b: 10 }], "t1", 15);
    expect(mocks.rpc).toHaveBeenCalledWith("report_placement_result", {
      p_match_id: "m3",
      p_games: [{ a: 21, b: 10 }],
      p_ended_minutes_ago: 15,
    });
  });

  it("carries the offset on the knockout path too", async () => {
    await reportTierDrawMatch("m4", [{ a: 21, b: 10 }], "t1", 30);
    expect(mocks.rpc).toHaveBeenCalledWith("report_tier_draw_result", {
      p_match_id: "m4",
      p_games: [{ a: 21, b: 10 }],
      p_ended_minutes_ago: 30,
    });
  });
});

/**
 * The dialog's snapshot, which is what makes the server's staleness check possible.
 *
 * The absence of the keys is the contract for a caller that is not checking, so every test
 * above still pins the old request shape. These pin the two shapes the desk actually sends.
 */
describe("the report RPC payload carries the dialog snapshot", () => {
  it("sends the status a first entry opened on, without inventing a result token", async () => {
    await reportPlacementMatch("m5", [{ a: 21, b: 10 }], "t1", 0, {
      status: "scheduled",
      reportedAt: null,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("report_placement_result", {
      p_match_id: "m5",
      p_games: [{ a: 21, b: 10 }],
      p_expected_status: "scheduled",
    });
  });

  it("sends both for a correction, where the token is what distinguishes two desks", async () => {
    const reportedAt = "2026-10-22T15:04:05.123456+00:00";
    await reportTierDrawMatch("m6", [{ a: 21, b: 10 }], "t1", 0, {
      status: "reported",
      reportedAt,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("report_tier_draw_result", {
      p_match_id: "m6",
      p_games: [{ a: 21, b: 10 }],
      p_expected_status: "reported",
      p_expected_reported_at: reportedAt,
    });
  });
});

/**
 * The mid-tournament RPCs.
 *
 * What is worth pinning here is the payload, because each argument is a decision the database then
 * acts on: the team, the category, the date a shift starts from, and which court a day moves onto.
 * The behaviour itself is `integration/` and, until that runs, the migration's own probes.
 */
describe("the mid-tournament payloads", () => {
  it("withdraws by team id alone", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 3, error: null });
    await expect(withdrawPlacementTeam("team-1")).resolves.toBe(3);
    expect(mocks.rpc).toHaveBeenCalledWith("withdraw_placement_team", { p_team_id: "team-1" });
  });

  it("adds a late entrant by category and team", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "entrant-1", error: null });
    await expect(addPlacementEntrant("cat-1", "team-2")).resolves.toBe("entrant-1");
    expect(mocks.rpc).toHaveBeenCalledWith("add_placement_entrant", {
      p_category_id: "cat-1",
      p_team_id: "team-2",
    });
  });

  it("shifts from a date, so the days before it stay put", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 4, error: null });
    await expect(shiftTournamentDays("t1", "2099-03-01", 7)).resolves.toBe(4);
    expect(mocks.rpc).toHaveBeenCalledWith("shift_tournament_days", {
      p_tournament_id: "t1",
      p_from_date: "2099-03-01",
      p_delta_days: 7,
    });
  });

  it("reassigns within one day, between two named courts", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 2, error: null });
    await expect(reassignCourtMatches("t1", "day-1", "court-broken", "court-3")).resolves.toBe(2);
    expect(mocks.rpc).toHaveBeenCalledWith("reassign_court_matches", {
      p_tournament_id: "t1",
      p_day_id: "day-1",
      p_from_court_id: "court-broken",
      p_to_court_id: "court-3",
    });
  });

  it("surfaces the database's refusal rather than a generic failure", async () => {
    // The refusal is the whole point of these functions: "on court right now" is a sentence the
    // desk can act on, and it would be lost if the action replaced it.
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "That team is on court right now (1 match). Finish or void the match first." },
    });
    await expect(withdrawPlacementTeam("team-1")).rejects.toThrow(/on court right now/);
  });
});
