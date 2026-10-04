import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceRedirect } from "@/components/workspace-redirect";

/**
 * `/matches` before the workspace move, now the tournament's own scores page.
 *
 * The page kept its job but took the name of what an operator calls it - a score is what
 * is entered, a match is what exists - so the old address has nothing to fall back on and
 * is redirected rather than merely moved.
 */
export const Route = createFileRoute("/matches")({
  component: () => <WorkspaceRedirect section="scores" />,
});
