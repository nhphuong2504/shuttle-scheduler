// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { order } = vi.hoisted(() => ({ order: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ order }) }) }) },
}));
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ signedIn: false }) }));
import { TournamentScopeContext, useTournamentScope, type TournamentDay } from "./data";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

function wrapper({ children }: { children: ReactNode }) {
  const client = clients[0]!;
  return (
    <QueryClientProvider client={client}>
      <TournamentScopeContext.Provider
        value={{
          tournament: null,
          tournamentId: "t1",
          accessLoading: false,
          access: {
            is_owner: false,
            is_editor: false,
            is_platform_admin: false,
            can_edit: false,
            can_manage_access: false,
          },
        }}
      >
        {children}
      </TournamentScopeContext.Provider>
    </QueryClientProvider>
  );
}

function setup() {
  let resolve!: (value: { data: TournamentDay[]; error: null }) => void;
  order.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  clients.push(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
  return { ...renderHook(() => useTournamentScope(), { wrapper }), resolve };
}

describe("the tournament's days while the network is pending", () => {
  it("keeps the empty list stable so a consumer effect cannot repeatedly reset its state", () => {
    const { result, rerender } = setup();
    const pendingDays = result.current.days;
    expect(result.current.loading).toBe(true);
    expect(pendingDays).toEqual([]);
    rerender();
    expect(result.current.days).toBe(pendingDays);
  });

  it("replaces the pending list with the server's days when they arrive", async () => {
    const { result, resolve, rerender } = setup();
    await act(async () => resolve({ data: [{ id: "day-1" } as TournamentDay], error: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.days.map((day) => day.id)).toEqual(["day-1"]);
    const loadedDays = result.current.days;
    rerender();
    expect(result.current.days).toBe(loadedDays);
  });
});
