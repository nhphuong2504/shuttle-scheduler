import { useSyncExternalStore } from "react";

import { supabase } from "@/integrations/supabase/client";
import type { StaffRoleName } from "@/lib/tournament/data";

type SessionUser = { userEmail: string | null; userId: string | null };

type SessionState = {
  session: SessionUser | null;
  role: StaffRoleName | null;
  ready: boolean;
};

const INITIAL_STATE: SessionState = { session: null, role: null, ready: false };

/**
 * Session + role are cached at module scope so they survive the `AppShell`
 * remount that happens on every route change. Each route renders its own
 * `<AppShell>`, so a per-component `useState` role would reset to `null` on
 * each navigation and make the role-gated "New event" / "Staff" links blink
 * out and back in.
 */
let state: SessionState = INITIAL_STATE;
const listeners = new Set<() => void>();

function setState(next: Partial<SessionState>) {
  const merged = { ...state, ...next };
  if (
    merged.session === state.session &&
    merged.role === state.role &&
    merged.ready === state.ready
  ) {
    return;
  }
  state = merged;
  for (const listener of listeners) listener();
}

let inFlight: Promise<void> | null = null;
let rerun = false;
let subscribed = false;

async function load() {
  try {
    const { data } = await supabase.auth.getSession();
    const next: SessionUser | null = data.session
      ? { userEmail: data.session.user.email ?? null, userId: data.session.user.id }
      : null;

    if (!next) {
      setState({ session: null, role: null, ready: true });
      return;
    }

    setState({ session: next });
    const { data: roleName } = await supabase.rpc("current_staff_role");
    // Ignore a stale response if the signed-in user changed while in flight.
    if (state.session?.userId !== next.userId) return;
    setState({ role: (roleName as StaffRoleName | null) ?? null, ready: true });
  } catch {
    // An unknown role is the safe default: keep the role-gated links hidden
    // rather than flashing privileges we could not verify. Settling `ready`
    // also stops every later mount from retrying on an unreachable backend.
    if (!state.ready) setState({ ready: true });
  }
}

function refresh() {
  // Coalesce concurrent mounts into one request, but make sure an auth change
  // that lands mid-flight is not swallowed: queue a follow-up run.
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = load().finally(() => {
    inFlight = null;
    if (rerun) {
      rerun = false;
      void refresh();
    }
  });
  return inFlight;
}

function ensureAuthSubscription() {
  if (subscribed) return;
  subscribed = true;
  supabase.auth.onAuthStateChange(() => {
    // Defer: calling other Supabase methods synchronously from this callback
    // can deadlock the auth client.
    setTimeout(() => void refresh(), 0);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Effects never run during SSR, but guard anyway so no request-scoped state
  // is ever written on the server.
  if (typeof window === "undefined") {
    return () => listeners.delete(listener);
  }
  ensureAuthSubscription();
  if (!state.ready) void refresh();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

export function useSession() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { session, role } = snapshot;

  const can = (...needed: StaffRoleName[]) => !!role && needed.includes(role);

  return {
    session,
    ready: snapshot.ready,
    signedIn: !!session,
    role,
    isAdmin: role === "admin",
    canRegister: can("admin", "registrar"),
    canScore: can("admin", "scorer"),
    canSchedule: can("admin", "scheduler"),
    canGenerate: can("admin", "registrar"),
  };
}
