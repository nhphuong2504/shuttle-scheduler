import { type Page } from "@playwright/test";

import { THEME_STORAGE_KEY, type Theme } from "../../src/lib/design/theme";

/**
 * The infrastructure matrix: routes x themes.
 *
 * The sweeps validate their axes against each other, so all of them - contrast,
 * focus, layout and hydration - must agree about what a "cell" is. Defining the axes
 * once here rather than in each spec is what makes that agreement structural: a route
 * added to `ROUTES` is picked up by every sweep at once, instead of silently appearing
 * in one and being missed by the others.
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

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export type MatrixCell = { theme: Theme };

/**
 * Every theme, in a fixed order so a run is reproducible.
 *
 * Theme is the only appearance axis there is. A route renders one type scale and one
 * row height, so every route is measured in both themes and there is no second axis to
 * cross them with.
 */
export const MATRIX_CELLS: readonly MatrixCell[] = THEMES.map((theme) => ({ theme }));

/**
 * A stable key for one cell of the matrix.
 *
 * The unmarked key is light, so every key recorded for the light theme keeps its
 * meaning and a baseline diff stays readable: `#dark` is an addition rather than a
 * rewrite.
 */
export function cellKey(route: string, cell: MatrixCell): string {
  return cell.theme === "dark" ? `${route}#dark` : route;
}

/** A readable name for a test title, so a failure names the cell rather than the key. */
export function cellLabel(cell: MatrixCell): string {
  return cell.theme;
}

/**
 * Sets the appearance before any document loads.
 *
 * `addInitScript` runs before the inline bootstrap in `<head>`, which matters: the point
 * is to have the *first* paint in the cell being measured, not to repaint into it after
 * hydration. A scan that waits for hydration to correct the page can miss anything that
 * only exists in the wrong initial state.
 *
 * The theme is always set explicitly, including when it equals the default. An empty
 * storage would resolve to the operating system's preference, which varies with the
 * machine running the suite and would make the matrix depend on the environment rather
 * than on the cell under test.
 */
export async function seedAppearance(page: Page, cell: MatrixCell): Promise<void> {
  await page.addInitScript(
    ([theme, themeKey]) => {
      try {
        localStorage.setItem(themeKey!, theme!);
      } catch {
        // Blocked storage leaves the page on its defaults. The sweep then measures the
        // system-default cell, and the baseline reports the other cell as a violation
        // rather than the run passing silently against the wrong appearance.
      }
    },
    [cell.theme, THEME_STORAGE_KEY],
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
  // would report two identical columns as if that were a result.
  const applied = await page.evaluate(() => ({
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  }));
  if (applied.theme !== cell.theme) {
    throw new Error(`${route} did not apply ${cellLabel(cell)}: got ${applied.theme}`);
  }
}
