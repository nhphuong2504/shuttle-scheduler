import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";

import { WorkspaceShell } from "@/components/app-shell";
import { useTournamentAccess } from "@/lib/auth/authorization";
import {
  TournamentScopeContext,
  useTournamentById,
  type TournamentScopeValue,
} from "@/lib/tournament/data";

export const Route = createFileRoute("/tournaments/$tournamentId")({
  component: TournamentLayout,
});

/**
 * The workspace layout: one tournament, resolved from the URL and shared with every
 * page under it.
 *
 * Three jobs, plus the chrome:
 *
 *  1. **Own the id.** Before this, each page resolved "which tournament am I showing"
 *     from `current_tournament_id()` - the caller's own working pointer. That made a
 *     URL meaningless as a link: the same address rendered a different tournament for
 *     each reader, and a viewer with no pointer saw nothing at all. The route is now
 *     the single answer, and `access` is resolved once here rather than once per page.
 *  2. **404 on an unknown id**, rather than rendering a workspace with no tournament in
 *     it. A missing tournament is a missing page, and the root route already has the
 *     404 to render.
 *  3. **Hand both down by context**, so the ~25 scoped hooks keep their shape and stop
 *     resolving a global.
 *  4. **Render the chrome**, through `WorkspaceShell`. It mounts once per workspace
 *     rather than once per navigation, so the header, the section nav and the session
 *     block survive a move between pages instead of being rebuilt, and the tournament's
 *     own name and status are stated once for every page beneath it. Each page supplies
 *     only its own `PageHeader` - its title and its actions.
 *
 * The shell is outside the provider and reads the context in turn, so the read-only
 * treatment and the section nav can both be derived from one access answer rather than
 * passed down as props.
 */
function TournamentLayout() {
  const { tournamentId } = Route.useParams();
  const tournamentQuery = useTournamentById(tournamentId);
  const { access, isLoading: accessLoading } = useTournamentAccess(tournamentId);

  // Only once the read has settled. Throwing while it is in flight would turn a slow
  // request on desk wifi into a 404, and the shell renders its own loading placeholder
  // for the window where `tournament` is still null.
  if (tournamentQuery.isSuccess && !tournamentQuery.data) {
    throw notFound();
  }

  const value: TournamentScopeValue = {
    tournament: tournamentQuery.data ?? null,
    tournamentId,
    access,
    accessLoading,
  };

  return (
    <TournamentScopeContext.Provider value={value}>
      <WorkspaceShell>
        <Outlet />
      </WorkspaceShell>
    </TournamentScopeContext.Provider>
  );
}
