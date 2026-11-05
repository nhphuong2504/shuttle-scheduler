import type { QueryClient } from "@tanstack/react-query";

/** The slice of the Supabase auth client this needs, so it can be tested without one. */
export interface AuthEvents {
  onAuthStateChange(
    callback: (event: string, session: { user: { id: string } } | null) => void,
  ): { data: { subscription: { unsubscribe(): void } } };
}

/**
 * Empties the query cache whenever the signed-in user changes.
 *
 * Every per-caller answer - this tournament's access above all, but also "my tournaments", the
 * registrations queue and the notification inbox - is cached under keys that do not name the
 * user, because within one session they never need to. Across sessions they do: an owner who
 * signed out and opened their tournament again was still handed the cached `can_edit` and shown
 * the operator's view until a reload, and someone signing in after a visitor was held to the
 * visitor's read-only answer for as long as it stayed fresh.
 *
 * So the cache belongs to one user. A change of user - sign-out, sign-in, or a different
 * account - resets every query: cached data is dropped and whatever is on screen fetches again
 * as the new caller, so nothing one user was told can be shown to the next. A token refresh or
 * the initial session event names the same user and changes nothing.
 *
 * Returns the unsubscribe, for the component that owns the client.
 */
export function bindQueryCacheToUser(queryClient: QueryClient, auth: AuthEvents): () => void {
  // Unknown until the first event, which reports whoever the page loaded as - not a change.
  let current: string | null | undefined;
  const { data } = auth.onAuthStateChange((_event, session) => {
    const next = session?.user.id ?? null;
    if (current === undefined) {
      current = next;
      return;
    }
    if (next === current) return;
    current = next;
    // Deferred: calling back into Supabase from inside this callback can deadlock the auth
    // client, and the refetches the reset starts read the session.
    setTimeout(() => void queryClient.resetQueries(), 0);
  });
  return () => data.subscription.unsubscribe();
}
