import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({
  rpc: vi.fn(async (): Promise<{ data: unknown; error: { message: string } | null }> => ({
    data: null,
    error: null,
  })),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
import { submitTournamentRegistration, withdrawTournamentRegistration } from "./participant";
import { decideTournamentRegistration } from "./review";
import { setRegistrationWindow } from "./window";

const mocks = { rpc };
beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
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
    await expect(withdrawTournamentRegistration("reg-1")).rejects.toThrow(/already been decided/i);
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

describe("setRegistrationWindow", () => {
  it("sends the exact instants and supports switching registration off", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await setRegistrationWindow("t1", "2030-10-01T09:00:00Z", "2030-10-20T09:00:00Z");
    expect(rpc).toHaveBeenLastCalledWith("set_registration_window", {
      p_tournament_id: "t1",
      p_opens: "2030-10-01T09:00:00Z",
      p_closes: "2030-10-20T09:00:00Z",
    });
    await setRegistrationWindow("t1", null, null);
    expect(rpc).toHaveBeenLastCalledWith("set_registration_window", {
      p_tournament_id: "t1",
      p_opens: null,
      p_closes: null,
    });
  });

  it("surfaces a refusal without replacing the server's explanation", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "The opening time is fixed once passed" },
    });
    await expect(setRegistrationWindow("t1", null, null)).rejects.toThrow(
      "The opening time is fixed once passed",
    );
  });
});
