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
  /**
   * The read `assertMatchUnchanged` makes. `state.row` is what the next read returns, so a
   * test can hand it a match that changed under the dialog without a database.
   */
  const state = { row: null as null | { status: string; reported_time: string | null } };
  const maybeSingle = vi.fn(async () => ({ data: state.row, error: null }));
  const select = vi.fn(() => ({ eq: () => ({ maybeSingle }) }));
  return { eq, update, rpc, select, maybeSingle, state };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ update: mocks.update, select: mocks.select }),
    rpc: mocks.rpc,
  },
}));

import {
  addTournamentDay,
  assertMatchUnchanged,
  decideTournamentRegistration,
  removeTournamentDay,
  setTournamentCourts,
  submitTournamentRegistration,
  updateTournamentMatchSettings,
  withdrawTournamentRegistration,
} from "./actions";

beforeEach(() => {
  mocks.update.mockClear();
  mocks.rpc.mockClear();
  mocks.select.mockClear();
  mocks.state.row = null;
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

/**
 * The registration pair, and the one thing about them this layer decides.
 *
 * Nothing here is gated on the client, deliberately: the RPC owns the cap, the window, the
 * per-player limit and each event's own state, and a pre-check here could only replace one
 * of its sentences with a vaguer one - or disagree with it. What this layer *does* decide is
 * the payload's shape, and that is what is asserted: the entries are shaped before they are
 * sent, and the returned request id is what a caller gets back.
 */
describe("submitTournamentRegistration", () => {
  it("shapes the entries into the jsonb the RPC documents", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "reg-1", error: null });
    await expect(
      submitTournamentRegistration("t1", [
        { categoryId: "cat-1" },
        { categoryId: "cat-2", partnerName: "Mei", partnerEmail: "mei@example.test" },
      ]),
    ).resolves.toBe("reg-1");

    expect(mocks.rpc).toHaveBeenCalledWith("submit_tournament_registration", {
      p_tournament_id: "t1",
      p_entries: [
        { category_id: "cat-1" },
        { category_id: "cat-2", partner_name: "Mei", partner_email: "mei@example.test" },
      ],
    });
  });

  it("sends an empty array rather than omitting the key", async () => {
    // The RPC's own first refusal is "Choose at least one event", and it can only answer
    // that if the key arrives. Omitting it would take the parameter's default and reach the
    // same sentence, but by a route nobody chose.
    mocks.rpc.mockResolvedValueOnce({ data: "reg-1", error: null });
    await submitTournamentRegistration("t1", []);
    expect(mocks.rpc).toHaveBeenCalledWith("submit_tournament_registration", {
      p_tournament_id: "t1",
      p_entries: [],
    });
  });

  it("surfaces the database's sentence for a refusal", async () => {
    // Every refusal is a sentence a person reads - "That event is not open for
    // registration", "This tournament allows at most 2 event(s) per player" - so the layer
    // must not replace it with a generic failure.
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "You cannot enter a doubles event with yourself as your partner" },
    });
    await expect(
      submitTournamentRegistration("t1", [{ categoryId: "cat-2", partnerEmail: "me@x.test" }]),
    ).rejects.toThrow(/with yourself as your partner/i);
  });

  it("refuses to return a resolved call with no request", async () => {
    // A uuid return that carries nothing is a state the schema cannot produce. Reporting it
    // is better than handing the caller `undefined` and letting a toast say "sent".
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(submitTournamentRegistration("t1", [{ categoryId: "cat-1" }])).rejects.toThrow(
      /could not be filed/i,
    );
  });
});

describe("withdrawTournamentRegistration", () => {
  it("withdraws by the request's own id, not by the tournament", async () => {
    // The act is the requester's own and it names the request, because the RPC refuses
    // anybody else's and a tournament id would leave it to the caller to have already
    // decided which request is theirs.
    await withdrawTournamentRegistration("reg-1");
    expect(mocks.rpc).toHaveBeenCalledWith("withdraw_tournament_registration", {
      p_registration_id: "reg-1",
    });
  });

  it("surfaces the refusal once a decision has been taken", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "This request has already been decided" },
    });
    await expect(withdrawTournamentRegistration("reg-1")).rejects.toThrow(
      /already been decided/i,
    );
  });
});

describe("decideTournamentRegistration", () => {
  it("names the request and the decision word, and nothing else", async () => {
    // The RPC takes one decision word for both outcomes rather than two functions: approval
    // and decline differ in what the function does, not in what the caller must know. The id
    // is the request's own, because a tournament id would leave it to the caller to have
    // already decided which request they meant.
    await decideTournamentRegistration({ registrationId: "reg-1", decision: "approved" });
    expect(mocks.rpc).toHaveBeenCalledWith("decide_tournament_registration", {
      p_registration_id: "reg-1",
      p_decision: "approved",
    });
  });

  it("sends the note when there is one, and omits the key when there is not", async () => {
    // An absent note and a null one are the same to the function; a blank one is a note the
    // reviewer did not write, so it must not be stored as whitespace.
    await decideTournamentRegistration({
      registrationId: "reg-1",
      decision: "rejected",
      note: "  Your partner is not registered yet.  ",
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith("decide_tournament_registration", {
      p_registration_id: "reg-1",
      p_decision: "rejected",
      p_note: "Your partner is not registered yet.",
    });

    await decideTournamentRegistration({
      registrationId: "reg-2",
      decision: "approved",
      note: "   ",
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith("decide_tournament_registration", {
      p_registration_id: "reg-2",
      p_decision: "approved",
    });
  });

  it("surfaces the refusal that names the full event", async () => {
    // "Mixed Doubles is full" is the sentence the reviewer needs, and it can only come from
    // the function that re-counts inside the transaction. Replacing it with a generic
    // failure would hide which event to look at.
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Mixed Doubles is full, so this request cannot be approved" },
    });
    await expect(
      decideTournamentRegistration({ registrationId: "reg-1", decision: "approved" }),
    ).rejects.toThrow(/Mixed Doubles is full/i);
  });
});

describe("assertMatchUnchanged", () => {
  it("reads the concurrency token, not only the status", async () => {
    mocks.state.row = { status: "reported", reported_time: "2026-01-01T10:00:00Z" };
    await assertMatchUnchanged("tier_draw_matches", "m1", "reported", "2026-01-01T10:00:00Z");
    expect(mocks.select).toHaveBeenCalledWith("status, reported_time");
  });

  it("refuses a match that another desk started or cleared", async () => {
    mocks.state.row = { status: "in-progress", reported_time: null };
    await expect(assertMatchUnchanged("tier_draw_matches", "m1", "scheduled")).rejects.toThrow(
      /changed to "in-progress"/,
    );
  });

  it("refuses a correction whose result changed while the dialog was open", async () => {
    // Status stays `reported` for a correction, which is why the status alone was not a
    // conflict: two desks correcting the same result both passed it.
    mocks.state.row = { status: "reported", reported_time: "2026-01-01T10:04:00Z" };
    await expect(
      assertMatchUnchanged("tier_draw_matches", "m1", "reported", "2026-01-01T10:00:00Z"),
    ).rejects.toThrow(/result was changed while you were entering it/i);
  });

  it("accepts an untouched match, including one with no reported time yet", async () => {
    mocks.state.row = { status: "scheduled", reported_time: null };
    await expect(
      assertMatchUnchanged("placement_matches", "m1", "scheduled", null),
    ).resolves.toBeUndefined();
  });

  it("skips the token when the caller does not supply one", async () => {
    // The restore paths only care about the status; they must not start failing on a
    // reported_time they never read.
    mocks.state.row = { status: "reported", reported_time: "2026-01-01T10:00:00Z" };
    await expect(assertMatchUnchanged("pool_matches", "m1", "reported")).resolves.toBeUndefined();
  });

  it("refuses a match that no longer exists", async () => {
    mocks.state.row = null;
    await expect(assertMatchUnchanged("pool_matches", "m1", "reported")).rejects.toThrow(
      /no longer exists/,
    );
  });
});
