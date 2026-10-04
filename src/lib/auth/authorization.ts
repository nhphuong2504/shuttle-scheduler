import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

/**
 * The single authorization surface for the browser.
 *
 * Two axes, kept apart exactly as they are in the database:
 *
 *   - Platform role answers *who* someone is: `admin` or `user`.
 *   - Tournament access answers *what they may do here*: owner, editor, or neither.
 *
 * Nothing in this file reads `status`. Lifecycle is a separate question with its own
 * vocabulary below, and a component that needs both asks both - which is the point,
 * because "may this person edit" and "is editing valid right now" have different
 * answers and different fixes.
 *
 * Every value here is a *mirror* of a database predicate, for rendering only. The
 * predicates remain the authority: each RPC re-checks on the server, so a stale or
 * forged browser value buys nothing but a confusing screen.
 */

export type SystemRole = "admin" | "user";

/** Roles are stored as text; only these two exist. Anything else reads as `user`. */
export function normalizeSystemRole(value: unknown): SystemRole {
  return value === "admin" ? "admin" : "user";
}

export function isPlatformAdmin(role: SystemRole | null | undefined): boolean {
  return role === "admin";
}

/**
 * The lifecycle states. `draft` and `published` are retired: a tournament is created
 * `upcoming`, and a state that means "not yet configured" no longer exists - that
 * question is answered by `tournament_is_ready`, which is data, not status.
 */
export type TournamentStatus = "upcoming" | "in_progress" | "completed";

export function normalizeTournamentStatus(value: unknown): TournamentStatus {
  return value === "in_progress" || value === "completed" ? value : "upcoming";
}

/** Configuration, seeding and initial bracket generation are valid here and nowhere else. */
export function isConfigurable(status: TournamentStatus): boolean {
  return status === "upcoming";
}

/** Scoring and live operation are valid here and nowhere else - not for an admin either. */
export function isLive(status: TournamentStatus): boolean {
  return status === "in_progress";
}

/** Terminal. Only a platform admin's named repair paths reach it. */
export function isCompleted(status: TournamentStatus): boolean {
  return status === "completed";
}

/**
 * The status label. `upcoming` needs its own branch rather than falling through to a
 * default, because the old default was `Draft` - so a missing branch relabels every
 * not-yet-started tournament as a state that no longer exists.
 */
export function tournamentStatusLabel(status: TournamentStatus): string {
  switch (status) {
    case "upcoming":
      return "Upcoming";
    case "in_progress":
      return "In progress";
    case "completed":
      return "Completed";
  }
}

/**
 * What the label means for the person reading it: whether setup is still open, and
 * what the next step is. Kept beside the label so the two cannot drift.
 */
export function tournamentStatusHint(status: TournamentStatus): string {
  switch (status) {
    case "upcoming":
      return "Still being set up. Ready to start once every check passes and the start time arrives.";
    case "in_progress":
      return "Running. Matches can be started and scored.";
    case "completed":
      return "Finished. Only a platform admin can repair anything now.";
  }
}

// ---------------------------------------------------------------------------
// Per-tournament access
// ---------------------------------------------------------------------------

/**
 * One tournament's access answer, for one caller. `can_manage_access` is ownership:
 * deleting the tournament and changing who may edit it are the owner's decisions, not
 * an editor's.
 */
export interface TournamentAccess {
  is_platform_admin: boolean;
  is_owner: boolean;
  is_editor: boolean;
  can_edit: boolean;
  can_manage_access: boolean;
}

/**
 * Deny everything.
 *
 * This is what an unresolved, failed or signed-out query returns, and it is the safe
 * default rather than an empty object: a component that renders before the answer
 * arrives hides the controls, and one that renders after a *failure* keeps them
 * hidden. A permissive default would flash edit affordances to a viewer on every
 * navigation and leave them there if the request failed.
 */
export const NO_ACCESS: TournamentAccess = {
  is_platform_admin: false,
  is_owner: false,
  is_editor: false,
  can_edit: false,
  can_manage_access: false,
};

export const accessKeys = {
  tournamentAccess: ["tournament_access"] as const,
};

/**
 * The one authorization read a tournament page makes.
 *
 * `tournament_access` is a single jsonb summary of the predicates rather than four
 * separate calls, because this runs on every navigation on desk wifi. It summarises;
 * it does not gate - the server re-checks on every write.
 *
 * A viewer's answer is all-false and is still a valid answer, so `isLoading` must not
 * be conflated with "no access": wait for the query before deciding what to render, or
 * the controls will blink on every mount.
 */
export function useTournamentAccess(tournamentId: string | null | undefined) {
  const query = useQuery({
    queryKey: [...accessKeys.tournamentAccess, tournamentId ?? null],
    enabled: !!tournamentId,
    // Access can change while a page is open - the owner adds you as an editor, or
    // removes you - so this is refreshed on the realtime invalidation like everything
    // else, and held briefly to avoid a request per mount.
    staleTime: 30_000,
    queryFn: async (): Promise<TournamentAccess> => {
      const { data, error } = await supabase.rpc("tournament_access", {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw new Error(error.message);
      return { ...NO_ACCESS, ...(data as unknown as Partial<TournamentAccess>) };
    },
  });

  return {
    access: query.data ?? NO_ACCESS,
    /**
     * True until the answer is known. Callers that hide controls must distinguish this
     * from "known to be false" only when they want a skeleton; for gating, both mean
     * "do not render the control".
     */
    isLoading: query.isLoading,
    refresh: query.refetch,
  };
}

/**
 * Convenience for the common case: a component that only needs the boolean. A viewer,
 * a signed-out visitor and a failed request all read `false`.
 */
export function useCanEdit(tournamentId: string | null | undefined): boolean {
  return useTournamentAccess(tournamentId).access.can_edit;
}
