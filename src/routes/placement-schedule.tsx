import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceRedirect } from "@/components/workspace-redirect";

/**
 * `/placement-schedule` before the workspace move.
 *
 * This is one of two old addresses for the same page - `/schedule` is the other - because
 * the two scheduling surfaces used to be two routes. They are one route now, chosen by the
 * tournament's format, so both bookmarks converge on `/tournaments/$id/schedule` and the
 * format decides which view renders. Neither old address has to know the format.
 */
export const Route = createFileRoute("/placement-schedule")({
  component: () => <WorkspaceRedirect section="schedule" />,
});
