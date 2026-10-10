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

import { reportPlacementMatch, reportTierDrawMatch } from "./placement-actions";

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
