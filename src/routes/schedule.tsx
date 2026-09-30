import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceRedirect } from "@/components/workspace-redirect";

/**
 * `/schedule` before the workspace move.
 *
 * The slug survives at the scoped address, but the page it names is now format-aware: this
 * address and `/placement-schedule` both resolve to `/tournaments/$id/schedule`, and the
 * tournament's stored format decides whether the placement scheduler or the day planner
 * renders. A caller who bookmarked the round-robin planner still gets the round-robin
 * planner, because the format has not changed - only the URL has.
 */
export const Route = createFileRoute("/schedule")({
  component: () => <WorkspaceRedirect section="schedule" />,
});
