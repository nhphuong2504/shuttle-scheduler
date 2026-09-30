/**
 * Where a caller with no working tournament is sent.
 *
 * The single source for every address that cannot name a tournament: the flat paths kept
 * for bookmarks (`/setup`, `/schedule`, …). It is one constant rather than a literal at
 * each call site because the callers must never disagree - somebody following a bookmark
 * and somebody who has never chosen a tournament have to land in the same place.
 *
 * It shipped as `/auth` and flipped to `/explore` in the commit that created the route, so
 * no caller was edited when the destination changed. `/explore` is the right answer now
 * that it exists: someone with no working tournament has nothing to resume, and the useful
 * thing to show them is what there is to work on rather than a sign-in form. A signed-in
 * caller who has never chosen a tournament gets the same page for the same reason, and it
 * offers sign-in from there.
 *
 * `/` used to be the second reader of this constant, through the temporary shim S3 shipped.
 * S6 replaced that shim with the real Landing/Home, which is a surface rather than a
 * redirect: a visitor sees what the app is and a signed-in caller sees their own
 * tournaments, including the empty state that used to be this constant's job.
 */
export const NO_POINTER_FALLBACK = "/explore" as const;

/**
 * A flat address's modern equivalent, named by the section rather than by the path.
 *
 * The map exists so a redirect says *which page* it means and the router says *where that
 * page lives*. Writing the scoped path at each call site would spread the workspace's URL
 * shape across eight files, and a later rename would have to find all of them.
 */
export const WORKSPACE_SECTIONS = {
  desk: "/tournaments/$tournamentId/desk",
  entries: "/tournaments/$tournamentId/entries",
  placement: "/tournaments/$tournamentId/placement",
  knockout: "/tournaments/$tournamentId/knockout",
  schedule: "/tournaments/$tournamentId/schedule",
  scores: "/tournaments/$tournamentId/scores",
  settings: "/tournaments/$tournamentId/settings",
  access: "/tournaments/$tournamentId/access",
  pools: "/tournaments/$tournamentId/pools",
  draws: "/tournaments/$tournamentId/draws",
} as const;

export type WorkspaceSection = keyof typeof WORKSPACE_SECTIONS;
