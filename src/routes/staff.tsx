import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceRedirect } from "@/components/workspace-redirect";

/**
 * `/staff` before the workspace move, now the tournament's own access page.
 *
 * Kept as a redirect rather than deleted because the address was shipped, and it is the
 * one an organiser has most likely saved: adding an editor is the thing you do from a
 * different machine than the desk. It resolves on the caller's own pointer, so the
 * bookmark opens the organiser's own tournament rather than a fixed one.
 */
export const Route = createFileRoute("/staff")({
  component: () => <WorkspaceRedirect section="access" />,
});
