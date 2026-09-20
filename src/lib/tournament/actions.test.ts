import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The client is stubbed so the guard rails can be exercised without a database.
 * Everything here is about what the action refuses to write, which is exactly the
 * part that would otherwise only be caught by a live call.
 */
const mocks = vi.hoisted(() => {
  const eq = vi.fn(async () => ({ error: null }));
  const update = vi.fn(() => ({ eq }));
  const rpc = vi.fn(async (): Promise<{ data: unknown; error: { message: string } | null }> => ({
    data: null,
    error: null,
  }));
  return { eq, update, rpc };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ update: mocks.update }),
    rpc: mocks.rpc,
  },
}));

import { setTournamentCourts, updateTournamentMatchSettings } from "./actions";

beforeEach(() => {
  mocks.update.mockClear();
  mocks.rpc.mockClear();
});

describe("updateTournamentMatchSettings", () => {
  it("refuses a best-of that is not a single game or an odd number", async () => {
    await expect(updateTournamentMatchSettings("t1", { knockoutBestOf: 2 })).rejects.toThrow(
      /single game or an odd best of/i,
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses a game target or a winning margin outside the readiness bounds", async () => {
    await expect(updateTournamentMatchSettings("t1", { placementGamesTo: 0 })).rejects.toThrow();
    await expect(updateTournamentMatchSettings("t1", { placementGamesTo: 100 })).rejects.toThrow();
    await expect(updateTournamentMatchSettings("t1", { knockoutWinBy: 21 })).rejects.toThrow();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("writes only the fields it was given, under their column names", async () => {
    await updateTournamentMatchSettings("t1", { placementBestOf: 3, placementGamesTo: 15 });
    expect(mocks.update).toHaveBeenCalledWith({
      placement_games_to: 15,
      placement_best_of: 3,
    });
    expect(mocks.eq).toHaveBeenCalledWith("id", "t1");
  });

  it("accepts every odd best-of the database allows", async () => {
    for (const bestOf of [1, 3, 5, 7, 9]) {
      await expect(updateTournamentMatchSettings("t1", { knockoutBestOf: bestOf })).resolves.toBe(
        undefined,
      );
    }
  });

  it("does nothing when the patch is empty", async () => {
    await updateTournamentMatchSettings("t1", {});
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("setTournamentCourts", () => {
  it("passes the count to the RPC and surfaces the database's refusal", async () => {
    await setTournamentCourts("t1", 6);
    expect(mocks.rpc).toHaveBeenCalledWith("set_tournament_courts", {
      p_tournament_id: "t1",
      p_count: 6,
    });
  });

  it("throws the database message when a court is still in use", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Cannot remove 1 court(s): they still hold a match." },
    });
    await expect(setTournamentCourts("t1", 2)).rejects.toThrow(/still hold a match/i);
  });
});
