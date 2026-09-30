import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceRedirect } from "@/components/workspace-redirect";

/**
 * A routing shim, not a surface.
 *
 * `/` used to be the Desk. S3 moved the Desk to `/tournaments/$tournamentId/desk`, but an
 * address that has been the app's front door cannot simply stop existing - bookmarks and
 * typed URLs still point at it, and a dead `/` reads as an outage. So `/` keeps working by
 * redirecting to the Desk on the caller's pointer, and S6 replaces this file with the real
 * Landing/Home.
 *
 * It renders nothing, on purpose. A designed placeholder would be a second surface built
 * to be thrown away, and worse, it would be a *second definition of `/`* that the real
 * route would have to displace without a visible seam.
 *
 * `/` is the only address allowed a shim rather than a redirect file, because it is the
 * only one whose owning step has not shipped yet.
 */
export const Route = createFileRoute("/")({
  component: () => <WorkspaceRedirect section="desk" />,
});
