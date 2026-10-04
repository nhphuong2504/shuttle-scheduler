import { useSyncExternalStore } from "react";

import { supabase } from "@/integrations/supabase/client";
import {
  isPlatformAdmin as platformAdminOf,
  normalizeSystemRole,
  type SystemRole,
} from "@/lib/auth/authorization";

type SessionUser = { userEmail: string | null; userId: string | null };

type SessionState = {
  session: SessionUser | null;
  systemRole: SystemRole | null;
  ready: boolean;
};

const INITIAL_STATE: SessionState = { session: null, systemRole: null, ready: false };

/**
 * Session + platform role are cached at module scope so they survive a shell remount.
 * The workspace shell mounts once per workspace rather than once per navigation, but it
 * is still remounted when a caller moves between the public pages and a workspace, and
 * the layout's own header reads the role to decide what to offer. A per-component
 * `useState` role would reset to `null` on each of those moves and make the role-gated
 * links blink out and back in.
 *
 * The platform role is the *only* thing cached here. Tournament access is not: it is
 * per tournament and belongs to `useTournamentAccess`, which is why nothing in this
 * hook says whether the caller may edit anything.
 */
let state: SessionState = INITIAL_STATE;
const listeners = new Set<() => void>();

function setState(next: Partial<SessionState>) {
  const merged = { ...state, ...next };
  if (
    merged.session === state.session &&
    merged.systemRole === state.systemRole &&
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
      setState({ session: null, systemRole: null, ready: true });
      return;
    }

    setState({ session: next });
    const { data: roleName } = await supabase.rpc("current_system_role");
    // Ignore a stale response if the signed-in user changed while in flight.
    if (state.session?.userId !== next.userId) return;
    // A missing or unrecognised role reads as `user`. That is the same direction the
    // database resolves in, so the browser never shows more than the server allows.
    setState({
      systemRole: roleName == null ? "user" : normalizeSystemRole(roleName),
      ready: true,
    });
  } catch {
    // An unknown role is the safe default: keep the privileged links hidden rather
    // than flashing privileges we could not verify. Settling `ready` also stops every
    // later mount from retrying on an unreachable backend.
    if (!state.ready) setState({ ready: true });
  }
}

function refresh() {
  // Coalesce concurrent mounts into one request, but make sure an auth change that
  // lands mid-flight is not swallowed: queue a follow-up run.
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
    // Defer: calling other Supabase methods synchronously from this callback can
    // deadlock the auth client.
    setTimeout(() => void refresh(), 0);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Effects never run during SSR, but guard anyway so no request-scoped state is ever
  // written on the server.
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

/**
 * Who is signed in, and what platform role they hold.
 *
 * Deliberately says nothing about what they may do. Every edit control is gated on
 * `useTournamentAccess(tournamentId)` instead, because "can this person edit" is a
 * per-tournament question now - a staff role could answer it globally, owner and
 * editor rows cannot.
 */
export function useSession() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { session, systemRole } = snapshot;

  return {
    session,
    ready: snapshot.ready,
    signedIn: !!session,
    systemRole,
    isPlatformAdmin: platformAdminOf(systemRole),
  };
}
