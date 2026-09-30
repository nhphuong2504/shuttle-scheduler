import { TOURNAMENT_ID } from "./desk-mock";

/**
 * The addresses the suite navigates to, in one place.
 *
 * Every operational page moved under `/tournaments/$tournamentId/...` when the workspace
 * layout landed, and the specs should name the *page* rather than paste a path. Two reasons
 * that matters here more than usual:
 *
 *  1. A pasted path is a route assertion that nobody meant to write. These specs assert what
 *     a page renders, so a typo in a URL would show up as a mysteriously empty page rather
 *     than as a wrong address.
 *  2. The old flat addresses now redirect *on the client* (see `WorkspaceRedirect`), so a
 *     spec that kept using them would be asserting a redirect completes, not a page. Pointing
 *     at the scoped address directly keeps each spec measuring one thing.
 *
 * The redirects themselves are covered on purpose, and only where they are the subject:
 * `/` is exercised by the routing spec, and the flat paths are exercised through the one
 * shared component they all render.
 */
export const routes = {
  desk: `/tournaments/${TOURNAMENT_ID}/desk`,
  entries: `/tournaments/${TOURNAMENT_ID}/entries`,
  placement: `/tournaments/${TOURNAMENT_ID}/placement`,
  knockout: `/tournaments/${TOURNAMENT_ID}/knockout`,
  schedule: `/tournaments/${TOURNAMENT_ID}/schedule`,
  scores: `/tournaments/${TOURNAMENT_ID}/scores`,
  settings: `/tournaments/${TOURNAMENT_ID}/settings`,
  access: `/tournaments/${TOURNAMENT_ID}/access`,
  pools: `/tournaments/${TOURNAMENT_ID}/pools`,
  draws: `/tournaments/${TOURNAMENT_ID}/draws`,
  /** The surfaces that are not about one tournament, so they name no id. */
  explore: "/explore",
  myTournaments: "/me/tournaments",
  newTournament: "/tournaments/new",
} as const;

/**
 * The flat addresses kept alive as redirects, and where each now lands.
 *
 * Exported as a list rather than as constants because its only caller walks it: the routing
 * spec visits each address and asserts the browser ended up at the scoped page. Keeping the
 * pairs here means the spec cannot assert a target the map does not name.
 *
 * `/` is the one entry whose target is not a workspace page: it is S3's shim, which resolves
 * on the caller's pointer and lands on the desk because this fixture's session has one. A
 * caller with no pointer lands on `/explore` instead - see `NO_POINTER_FALLBACK` - and that
 * is covered where the fallback lives rather than by a second walk here. S6 replaces the shim
 * with the real Landing/Home and this entry moves with it.
 */
export const legacyRoutes: readonly { from: string; to: string }[] = [
  { from: "/", to: routes.desk },
  { from: "/setup", to: routes.settings },
  { from: "/staff", to: routes.access },
  { from: "/registration", to: routes.entries },
  { from: "/placement", to: routes.placement },
  { from: "/knockout", to: routes.knockout },
  { from: "/placement-schedule", to: routes.schedule },
  { from: "/schedule", to: routes.schedule },
  { from: "/matches", to: routes.scores },
];

/** Where a caller with no working tournament is sent. Mirrors `NO_POINTER_FALLBACK`. */
export const NO_POINTER_FALLBACK = routes.explore;
