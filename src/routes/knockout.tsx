import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceRedirect } from "@/components/workspace-redirect";

/**
 * `/knockout` before the workspace move.
 *
 * The surface is unchanged and so is its slug - only the tournament it sits inside is new
 * information, and that comes from the route. The redirect exists so the old address keeps
 * resolving on the caller's own pointer instead of 404ing.
 */
export const Route = createFileRoute("/knockout")({
  component: () => <WorkspaceRedirect section="knockout" />,
});
