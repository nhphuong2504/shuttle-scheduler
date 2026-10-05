import { type Page } from "@playwright/test";

import { routes } from "./routes";

/**
 * The route list the rendering specs share.
 *
 * Navigation is the one axis the suites still cross, and defining the list once here
 * rather than in each spec is what makes a route added to `ROUTES` show up everywhere at
 * once instead of silently appearing in one sweep and being missed by the others.
 *
 * This module lives in `fixtures/` rather than beside the specs because Playwright's
 * `testDir` only collects `*.spec.ts` - a non-spec module here is importable without
 * being mistaken for a test file.
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
   * `public-surfaces.spec.ts`.
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
 * The one rendering the route sweeps share.
 *
 * Dark mode is gone, so there is no appearance axis to cross a route with: every surface
 * renders the light palette. The cell keeps its shape so the sweeps' fixtures and test
 * titles do not have to change while the last of them are removed.
 */
export type MatrixCell = { theme: "light" };

export const MATRIX_CELLS: readonly MatrixCell[] = [{ theme: "light" }];

/** A readable name for a test title, so a failure names the cell rather than a key. */
export function cellLabel(cell: MatrixCell): string {
  return cell.theme;
}

/**
 * Navigates and waits for the page to settle, asserting the light rendering applied.
 *
 * Waits for hydration explicitly rather than leaning on `load` or `networkidle`.
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
export async function openCell(page: Page, route: string, cell: MatrixCell): Promise<void> {
  const response = await page.goto(route, { waitUntil: "domcontentloaded" });
  // A redirect to sign-in is a legitimate response; a 5xx is not.
  if ((response?.status() ?? 0) >= 500) {
    throw new Error(`${route} returned HTTP ${response?.status()}`);
  }

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

  // The appearance is verified rather than assumed: the `dark` class must never appear
  // now that light is the only theme, so a regression that reintroduced it fails here.
  const applied = await page.evaluate(() => ({
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  }));
  if (applied.theme !== cell.theme) {
    throw new Error(`${route} did not apply ${cellLabel(cell)}: got ${applied.theme}`);
  }
}
