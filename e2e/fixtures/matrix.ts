import { type Page } from "@playwright/test";

import { routes } from "./routes";

/**
 * The infrastructure matrix: the routes every sweep agrees on.
 *
 * The sweeps validate their axes against each other, so all of them - contrast,
 * focus, layout and hydration - must agree about what a "cell" is. Defining the axes
 * once here rather than in each spec is what makes that agreement structural: a route
 * added to `ROUTES` is picked up by every sweep at once, instead of silently appearing
 * in one and being missed by the others.
 *
 * A cell used to be a (route, theme) pair. There is no theme axis any more: light is
 * the app's only appearance, so a cell is a route and nothing else. `MATRIX_CELLS` and
 * the `cell*` helpers remain so the sweeps that iterate them did not have to be
 * rewritten.
 *
 * This module lives in `fixtures/` rather than beside the specs because Playwright's
 * `testDir` only collects `*.spec.ts` - a non-spec module here is importable without
 * being mistaken for a test file.
 *
 * `fixtures/` is otherwise the Desk mock. That is unrelated; the directory is just the
 * conventional home for shared test code.
 */

/**
 * Every route the app can render, not just the ones in the nav.
 *
 * `/auth`, `/pools` and `/staff` were all reachable and all unscanned, which is how
 * `/staff` kept two critical violations - an unnamed combobox and an unlabelled input, the
 * same defect P2 fixed on `/registration` - through two phases of accessibility work. A
 * gate is only as complete as its route list, so the list comes from the route files
 * rather than from the navigation.
 *
 * **Every operational address is a workspace address now**, so they all carry the fixture
 * tournament's id. `routes.ts` owns those strings; this list names the pages.
 *
 * One entry deserves a note, because the count went *down* rather than up: `/schedule` and
 * `/placement-schedule` used to be two routes and are now one, so listing both would scan
 * the same component twice and call it coverage. The format decides which of the two
 * scheduling views renders, and this fixture runs the placement format - the day planner is
 * measured in `schedule-formats.spec.ts`, which asks the mock for a round-robin tournament.
 *
 * `/pools` renders the replaced round-robin engine and is reachable only by direct URL. It
 * is included deliberately: "not in the nav" is not "not shipped".
 *
 * Signed-in-only surfaces - the settings panels and the score dialogs - are not covered
 * here, because they are gated by a role rather than a route. The staff-session suite
 * covers those.
 */
export const ROUTES = [
  routes.tournament,
  routes.desk,
  routes.entries,
  routes.placement,
  routes.draws,
  routes.knockout,
  routes.schedule,
  routes.scores,
  routes.settings,
  routes.access,
  routes.registrations,
  /**
   * The surfaces that are about tournaments rather than *inside* one, and therefore
   * carry no id.
   *
   * They were added in S5, when they first existed, and `/` joined them in S6: leaving any
   * of them out would have made the route list a list of the routes somebody remembered.
   * They are the pages an unauthenticated visitor meets first, which is exactly the
   * audience least likely to be in any sweep's author's head.
   *
   * `/` renders its *visitor* reading here, because this list is swept signed out. The
   * signed-in reading - Home - needs a session, so it is scanned in
   * `public-surfaces.spec.ts` against the same axe tags.
   */
  routes.home,
  routes.explore,
  routes.myTournaments,
  routes.newTournament,
  "/auth",
  routes.pools,
] as const;

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * One cell of the matrix. Light is the app's only appearance, so a cell carries no choice
 * to make; it exists so the sweeps that iterate `MATRIX_CELLS` did not have to be
 * rewritten when the theme axis was removed.
 */
export type MatrixCell = Record<string, never>;

export const MATRIX_CELLS: readonly MatrixCell[] = [{}];

/** A stable key for one cell of the matrix: the route, unmarked. */
export function cellKey(route: string): string {
  return route;
}

/** A readable name for a test title: the appearance the cell was measured in. */
export function cellLabel(_cell: MatrixCell): string {
  return "light";
}

/** Navigates and waits for the page to settle, asserting the cell actually applied. */
export async function openCell(page: Page, route: string, _cell: MatrixCell): Promise<void> {
  const response = await page.goto(route, { waitUntil: "domcontentloaded" });
  // A redirect to sign-in is a legitimate response; a 5xx is not.
  if ((response?.status() ?? 0) >= 500) {
    throw new Error(`${route} returned HTTP ${response?.status()}`);
  }

  /**
   * Waits for hydration explicitly rather than leaning on `load` or `networkidle`.
   *
   * `domcontentloaded` returns as soon as the markup is parsed, so this overlaps the
   * resource loading that used to happen first, and the anchor is exact: `data-hydrated`
   * is set by React's mount effect, so it means the tree really is rendered rather than
   * that the network happened to go quiet for 500ms.
   *
   * `networkidle` is then a cheap confirmation rather than the primary signal. It is a
   * readability heuristic - Vite's HMR socket and lazily-imported chunks can keep it
   * waiting - and using it as the anchor is what made this helper slow enough to time out
   * under load. It is kept because a route that keeps fetching after hydration would
   * otherwise be scanned mid-flight.
   */
  await page.waitForFunction(
    () => document.documentElement.dataset["hydrated"] === "true",
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForLoadState("networkidle");

  // Fonts must be resolved before anything is measured or scanned. An unloaded web font
  // has different metrics, which silently invalidates both contrast resolution (the
  // rendered size decides the threshold) and any geometry comparison.
  await page.evaluate(() => document.fonts.ready);

  // The appearance is verified rather than assumed: the sweep measures the light palette
  // only, and a page resolving to any other `color-scheme` would silently invalidate every
  // colour measurement in the suite.
  const declared = await page.evaluate(
    () => getComputedStyle(document.documentElement).colorScheme,
  );
  if (!declared.includes("light")) {
    throw new Error(`${route} did not declare a light color-scheme: got "${declared}"`);
  }
}
