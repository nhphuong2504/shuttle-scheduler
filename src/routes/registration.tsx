import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceRedirect } from "@/components/workspace-redirect";

/**
 * `/registration` before the workspace move, now the operator's entries page.
 *
 * The page keeps its job but changed both name and address. `entries` says what it lists,
 * where `registration` read as something a participant does, so a bookmark of the old
 * address has nothing to fall back on and must be redirected rather than merely moved.
 *
 * Note the deliberate contrast with `/tournaments/$id/registrations`, which S11 adds for
 * the *approval queue*: the new concept takes the new word, and the operator's list keeps
 * the one that describes it. Resolving that collision here, in the step that rewrites the
 * whole route map, is why the rename lands now instead of in S11.
 */
export const Route = createFileRoute("/registration")({
  component: () => <WorkspaceRedirect section="entries" />,
});
