import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  NO_POINTER_FALLBACK,
  WORKSPACE_SECTIONS,
  type WorkspaceSection,
} from "@/lib/routing/workspace-redirect";
import { useCurrentTournamentPointer } from "@/lib/tournament/data";

/**
 * Sends a caller who asked for a page without naming a tournament to that page on their
 * own working tournament.
 *
 * ## Why this is a component and not a `beforeLoad` redirect
 *
 * The pointer is a *session* fact - it is `profiles.current_tournament_id` for whoever is
 * signed in - and the session lives only in the browser. `beforeLoad` also runs during
 * server rendering, where there is no session: the request would be anonymous, and
 * `current_tournament_id()` would answer with the public desk default instead. A bookmark
 * would then be redirected, by the *server*, to whatever tournament is publicly default
 * rather than to the one its owner is working in.
 *
 * It is worse than merely wrong, too. That server-side call is a real request to the
 * Supabase project, made by the rendering process rather than the page, so no browser-level
 * network interception can see it - which would quietly put the hermetic Playwright suite
 * back on the network it was built to leave.
 *
 * A component runs after hydration, on the browser, with the real session. Nothing is
 * fetched during server rendering (`useQuery` does not fetch on the server), so this
 * renders `null` there and stays hermetic - and it renders nothing at all in the browser
 * either, because it is a redirect and a placeholder would be a surface built to be thrown
 * away.
 *
 * `/` used to render this component, because `/` was the Desk before S3 moved it and a
 * shipped address cannot simply stop existing. S6 replaced that shim with the real
 * Landing/Home, so the callers now are the flat paths alone - each of which was, and still
 * is, a real address somebody may have bookmarked.
 */
export function WorkspaceRedirect({ section }: { section: WorkspaceSection }) {
  const navigate = useNavigate();
  const pointer = useCurrentTournamentPointer();
  const tournamentId = pointer.data ?? null;

  useEffect(() => {
    // Nothing is decided until the pointer has actually answered. Redirecting on the
    // loading state would send someone to the fallback for a moment and then to their
    // tournament, which is a visible flicker through the sign-in page.
    if (!pointer.isSuccess) return;

    if (!tournamentId) {
      void navigate({ to: NO_POINTER_FALLBACK, replace: true });
      return;
    }

    void navigate({
      to: WORKSPACE_SECTIONS[section],
      params: { tournamentId },
      replace: true,
    });
  }, [pointer.isSuccess, tournamentId, section, navigate]);

  return null;
}
