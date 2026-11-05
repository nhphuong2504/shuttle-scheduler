import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindQueryCacheToUser, type AuthEvents } from "./session-cache";

/** A stand-in for `supabase.auth` that lets a test fire auth events by hand. */
function fakeAuth() {
  let listener: ((event: string, session: { user: { id: string } } | null) => void) | null = null;
  const unsubscribe = vi.fn();
  const auth: AuthEvents = {
    onAuthStateChange(callback) {
      listener = callback;
      return { data: { subscription: { unsubscribe } } };
    },
  };
  const as = (id: string | null) => (id ? { user: { id } } : null);
  return {
    auth,
    unsubscribe,
    fire: (event: string, id: string | null) => listener?.(event, as(id)),
  };
}

const ACCESS = ["tournament-access", "t1"];

describe("bindQueryCacheToUser", () => {
  let client: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient();
    client.setQueryData(ACCESS, { can_edit: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    client.clear();
  });

  it("drops an owner's cached access when they sign out", () => {
    const { auth, fire } = fakeAuth();
    bindQueryCacheToUser(client, auth);
    fire("INITIAL_SESSION", "owner");
    fire("SIGNED_OUT", null);
    vi.runAllTimers();
    expect(client.getQueryData(ACCESS)).toBeUndefined();
  });

  it("drops a visitor's cached answers when someone signs in", () => {
    const { auth, fire } = fakeAuth();
    client.setQueryData(ACCESS, { can_edit: false });
    bindQueryCacheToUser(client, auth);
    fire("INITIAL_SESSION", null);
    fire("SIGNED_IN", "owner");
    vi.runAllTimers();
    expect(client.getQueryData(ACCESS)).toBeUndefined();
  });

  it("drops the cache when a different account signs in", () => {
    const { auth, fire } = fakeAuth();
    bindQueryCacheToUser(client, auth);
    fire("INITIAL_SESSION", "owner");
    fire("SIGNED_IN", "someone-else");
    vi.runAllTimers();
    expect(client.getQueryData(ACCESS)).toBeUndefined();
  });

  it("keeps the cache through the first event and a token refresh for the same user", () => {
    const { auth, fire } = fakeAuth();
    bindQueryCacheToUser(client, auth);
    fire("INITIAL_SESSION", "owner");
    fire("TOKEN_REFRESHED", "owner");
    fire("SIGNED_IN", "owner");
    vi.runAllTimers();
    expect(client.getQueryData(ACCESS)).toEqual({ can_edit: true });
  });

  it("stops listening when unbound", () => {
    const { auth, unsubscribe } = fakeAuth();
    bindQueryCacheToUser(client, auth)();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
