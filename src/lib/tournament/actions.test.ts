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

import {
  addTournamentDay,
  removeTournamentDay,
  setTournamentCourts,
  updateTournamentMatchSettings,
} from "./actions";

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

  it("refuses a game target or a winning margin outside the supported bounds", async () => {
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

describe("addTournamentDay", () => {
  it("passes the date and lets the database choose the position", async () => {
    // The action deliberately does not send a day number: the date decides where the
    // day lands, and the database renumbers to keep day_number in date order.
    mocks.rpc.mockResolvedValueOnce({ data: "day-9", error: null });
    await expect(addTournamentDay("t1", "2026-09-22")).resolves.toBe("day-9");
    expect(mocks.rpc).toHaveBeenCalledWith("add_tournament_day", {
      p_tournament_id: "t1",
      p_date: "2026-09-22",
    });
  });

  it("sends a window only when one is given", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "day-9", error: null });
    await addTournamentDay("t1", "2026-09-22", { startTime: "08:00", endTime: "17:00" });
    expect(mocks.rpc).toHaveBeenLastCalledWith("add_tournament_day", {
      p_tournament_id: "t1",
      p_date: "2026-09-22",
      p_start_time: "08:00",
      p_end_time: "17:00",
    });
  });

  it("surfaces the database's refusal at the seven-day cap", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "A tournament can have at most 7 days" },
    });
    await expect(addTournamentDay("t1", "2026-09-22")).rejects.toThrow(/at most 7 days/i);
  });
});

describe("removeTournamentDay", () => {
  it("calls the RPC with the day to drop", async () => {
    await removeTournamentDay("t1", "day-2");
    expect(mocks.rpc).toHaveBeenCalledWith("remove_tournament_day", {
      p_tournament_id: "t1",
      p_day_id: "day-2",
    });
  });

  it("surfaces the refusal when the day still has matches", async () => {
    // The wording is the host-facing explanation, so it must survive the layer
    // unchanged rather than being replaced by a generic failure.
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Day 2 still has 6 match(es) on it." },
    });
    await expect(removeTournamentDay("t1", "day-2")).rejects.toThrow(/still has 6 match/i);
  });

  it("surfaces the refusal for the last remaining day", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "A tournament needs at least one day" },
    });
    await expect(removeTournamentDay("t1", "day-1")).rejects.toThrow(/at least one day/i);
  });
});
