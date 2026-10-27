// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), session: { signedIn: false } }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("@/hooks/useSession", () => ({ useSession: () => mocks.session }));

import { useMyTournamentRegistration } from "./participant";
import { usePendingRegistrationCounts, useTournamentRegistrationQueue } from "./review";
import { useTournamentRegistrationState } from "./window";

const clients: QueryClient[] = [];
function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.session.signedIn = false;
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

const pending = {
  registration_id: "r1",
  status: "pending",
  created_at: "2030-10-01T09:00:00Z",
  entry_id: "e1",
  category_id: "c1",
  category_code: "MS",
  category_name: "Singles",
};

describe("registration reads", () => {
  it("reads the public window without a session and closes unknown states safely", async () => {
    mocks.rpc.mockResolvedValue({ data: "unexpected-state", error: null });
    const { result } = renderHook(() => useTournamentRegistrationState("t1"), queryWrapper());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe("not_offered");
    expect(mocks.rpc).toHaveBeenCalledWith("tournament_registration_state", {
      p_tournament_id: "t1",
    });
  });

  it("does not issue reads without a tournament, or an own-request read while signed out", () => {
    renderHook(() => {
      useTournamentRegistrationState(null);
      useMyTournamentRegistration("t1");
      useTournamentRegistrationQueue(undefined);
    }, queryWrapper());
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reads the participant's own request once signed in, with no review request", async () => {
    mocks.session.signedIn = true;
    mocks.rpc.mockResolvedValue({ data: [pending], error: null });
    const { result } = renderHook(() => useMyTournamentRegistration("t1"), queryWrapper());
    await waitFor(() => expect(result.current.data?.id).toBe("r1"));
    expect(result.current.data?.entries[0]?.categoryCode).toBe("MS");
    expect(mocks.rpc.mock.calls).toEqual([
      ["my_tournament_registration", { p_tournament_id: "t1" }],
    ]);
  });

  it("keeps different tournaments' requests in separate cache entries", async () => {
    mocks.session.signedIn = true;
    mocks.rpc.mockImplementation(async (_name, { p_tournament_id }) => ({
      data: [{ ...pending, registration_id: `request-${p_tournament_id}` }],
      error: null,
    }));
    const { result, rerender } = renderHook(({ id }) => useMyTournamentRegistration(id), {
      ...queryWrapper(),
      initialProps: { id: "t1" },
    });
    await waitFor(() => expect(result.current.data?.id).toBe("request-t1"));
    rerender({ id: "t2" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.id).toBe("request-t2"));
  });

  it("does not fetch the review queue when the surface withholds edit access", () => {
    renderHook(() => useTournamentRegistrationQueue("t1", { enabled: false }), queryWrapper());
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("shares the queue fetch with badges and counts requests rather than entry rows", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        pending,
        { ...pending, entry_id: "e2" },
        { ...pending, registration_id: "r2", status: "approved" },
      ],
      error: null,
    });
    const { result, client } = (() => {
      const { wrapper, client } = queryWrapper();
      return {
        ...renderHook(
          () => ({
            queue: useTournamentRegistrationQueue("t1"),
            counts: usePendingRegistrationCounts(["t1"]),
          }),
          { wrapper },
        ),
        client,
      };
    })();
    await waitFor(() => expect(result.current.counts.get("t1")).toBe(1));
    expect(result.current.queue.data?.pending[0]?.entries).toHaveLength(2);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    // Existing mutation invalidations must still refresh both readers using the old prefix.
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await client.invalidateQueries({ queryKey: ["registration_queue"] });
    await waitFor(() => expect(result.current.counts.get("t1")).toBe(0));
    expect(result.current.queue.data).toEqual({ pending: [], decided: [] });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("surfaces a backend read refusal instead of reporting an empty successful queue", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "Not authorized" } });
    const { result } = renderHook(() => useTournamentRegistrationQueue("t1"), queryWrapper());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Not authorized");
    expect(result.current.data).toBeUndefined();
  });
});
