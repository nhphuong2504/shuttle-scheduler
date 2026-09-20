import { type Page } from "@playwright/test";

import { DENSITY_STORAGE_KEY, type Density } from "../../src/lib/design/density";
import { THEME_STORAGE_KEY, type Theme } from "../../src/lib/design/theme";

/**
 * The infrastructure matrix: routes x themes x densities.
 *
 * P4 validates these three axes against each other, so all three sweeps - contrast,
 * focus and layout - must agree about what a "cell" is. Defining the axes once here
 * rather than in each spec is what makes that agreement structural: a route added to
 * `ROUTES` is picked up by every sweep at once, instead of silently appearing in one
 * and being missed by the others.
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
 * `/auth`, `/pools`, `/schedule` and `/staff` were all reachable and all unscanned, which
 * is how `/staff` kept two critical violations - an unnamed combobox and an unlabelled
 * input, the same defect P2 fixed on `/registration` - through two phases of
 * accessibility work. A gate is only as complete as its route list, so the list comes
 * from the route files rather than from the navigation.
 *
 * `/pools` and `/schedule` render the replaced round-robin engine and are reachable only
 * by direct URL. They are included deliberately: "not in the nav" is not "not shipped".
 *
 * Signed-in-only surfaces - the settings panels and the score dialogs - are not covered
 * here, because they are gated by a role rather than a route. The staff-session suite
 * covers those.
 */
export const ROUTES = [
  "/",
  "/registration",
  "/placement",
  "/draws",
  "/knockout",
  "/placement-schedule",
  "/matches",
  "/setup",
  "/staff",
  "/auth",
  "/pools",
  "/schedule",
] as const;

export const THEMES = ["light", "dark"] as const satisfies readonly Theme[];
export const DENSITIES = ["comfortable", "compact"] as const satisfies readonly Density[];

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export type MatrixCell = { theme: Theme; density: Density };

/**
 * All four combinations, in a fixed order so a run is reproducible.
 *
 * Every route is scanned in every cell rather than only in its own default density.
 * That is deliberate: the Desk's default is Compact, so scanning it at Comfortable is
 * testing the override path, and scanning a comfortable route at Compact is testing the
 * path its own default hides. A matrix measured only at each route's default is four
 * independent measurements pretending to be a grid.
 */
export const MATRIX_CELLS: readonly MatrixCell[] = THEMES.flatMap((theme) =>
  DENSITIES.map((density) => ({ theme, density })),
);

/**
 * A stable key for one cell of the matrix.
 *
 * The unmarked key is light + comfortable, so the 24 keys recorded before this phase
 * keep their meaning and the baseline diff is readable: `#dark` and `#compact` are
 * additions rather than a rewrite.
 */
export function cellKey(route: string, cell: MatrixCell): string {
  const marks = [
    cell.theme === "dark" ? "dark" : null,
    cell.density === "compact" ? "compact" : null,
  ];
  const present = marks.filter((mark): mark is string => mark !== null);
  return present.length === 0 ? route : `${route}#${present.join("+")}`;
}

/** A readable name for a test title, so a failure names the cell rather than the key. */
export function cellLabel(cell: MatrixCell): string {
  return `${cell.theme}, ${cell.density}`;
}

/**
 * Sets the appearance before any document loads.
 *
 * `addInitScript` runs before the inline bootstrap in `<head>`, which matters: the point
 * is to have the *first* paint in the cell being measured, not to repaint into it after
 * hydration. A scan that waits for hydration to correct the page can miss anything that
 * only exists in the wrong initial state.
 *
 * Both preferences are set explicitly, including when the value equals the default. An
 * empty storage would resolve the same way for most routes, but the Desk's density
 * default differs by route, so leaving it implicit would make the matrix depend on which
 * route happened to be under test.
 */
export async function seedAppearance(page: Page, cell: MatrixCell): Promise<void> {
  await page.addInitScript(
    ([theme, density, themeKey, densityKey]) => {
      try {
        localStorage.setItem(themeKey!, theme!);
        localStorage.setItem(densityKey!, density!);
      } catch {
        // Blocked storage leaves the page on its defaults. The sweep then measures the
        // default cell, and the baseline reports the other cells as violations rather
        // than the run passing silently against the wrong appearance.
      }
    },
    [cell.theme, cell.density, THEME_STORAGE_KEY, DENSITY_STORAGE_KEY],
  );
}

/** Navigates and waits for the page to settle, asserting the cell actually applied. */
export async function openCell(page: Page, route: string, cell: MatrixCell): Promise<void> {
  await seedAppearance(page, cell);

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

  // The appearance is verified rather than assumed. If storage were blocked or the
  // bootstrap were broken, every cell would silently render the same way and the matrix
  // would report four identical columns as if that were a result.
  const applied = await page.evaluate(() => ({
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    density: document.documentElement.dataset["density"],
  }));
  if (applied.theme !== cell.theme || applied.density !== cell.density) {
    throw new Error(
      `${route} did not apply ${cellLabel(cell)}: got ${applied.theme}, ${applied.density}`,
    );
  }
}
