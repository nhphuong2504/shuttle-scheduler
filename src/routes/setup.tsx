import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceRedirect } from "@/components/workspace-redirect";

/**
 * `/setup` before the workspace move, now the tournament's own settings page.
 *
 * Kept as a redirect rather than deleted because the address was shipped: it is in
 * bookmarks, in the browser's history, and in whatever notes an operator wrote during an
 * event. It resolves on the caller's own pointer, so the bookmark opens the referee's own
 * tournament rather than a fixed one.
 */
export const Route = createFileRoute("/setup")({
  component: () => <WorkspaceRedirect section="settings" />,
});
