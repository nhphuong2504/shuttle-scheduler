import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";

import { cellLabel, MATRIX_CELLS, openCell } from "./fixtures/matrix";
import { COLOUR_HELPERS } from "./fixtures/probes";
import { routes } from "./fixtures/routes";
/**
 * The WCAG 2.2 AA criteria that no axe rule reaches, measured rather than asserted.
 *
 * Phase 7 established this list by measurement, not by reading the docs: every route was
 * scanned and the criteria axe actually reported on were collected. Axe covers contrast
 * for text (1.4.3), names, roles, labels, target size (2.5.8), reflow's viewport meta
 * (1.4.4) and inline spacing (1.4.12) - and it maps no rule at all to the criteria below.
 * Two of them are ones this design system makes explicit written claims about, which is
 * why leaving them to a manual checklist would have been the wrong call rather than the
 * convenient one.
 *
 *   1.4.11 Non-text contrast    - "3:1 for UI borders" is stated in styles.css, and the
 *                                 gate had never measured a border. It found the selected
 *                                 state at 1.09:1, on every control that marks a choice.
 *   1.4.10 Reflow               - the sweep asserted no horizontal scroll at 1366px, which
 *                                 is a desktop width and not the criterion's.
 *   2.4.11 Focus not obscured   - new in 2.2, and this app has a sticky header.
 *   2.3.3  Reduced motion       - AAA, and nothing in the stylesheet responded to it.
 *
 * What this file is not: a conformance claim. It measures four properties on a handful of
 * surfaces. The criteria that genuinely need a person - screen reader behaviour, real
 * colour vision, logical focus order, whether a label is understandable - are listed in
 * the design canvas as a manual checklist and are not covered by anything here.
 */

/**
 * The route-wide criteria - 1.4.11 selected states and control edges, focus indicator
 * contrast, 1.4.10 reflow and 2.4.11 focus not obscured - are measured in
 * `route-sweep.spec.ts`, from the same load of each route as every other sweep. What stays
 * here is what needs its own page state: motion, dragging and the toasts.
 */

test.describe("2.3.3 reduced motion", () => {
  /**
   * AAA, so this is not part of what AA requires and is recorded as such rather than
   * presented as a conformance result. It is here because nothing in the stylesheet
   * responded to the preference before this phase, and this check is what keeps the new
   * rule from being deleted by someone who does not know what it was for.
   */
  for (const cell of MATRIX_CELLS) {
    test(`a reduced-motion preference actually reduces motion (${cellLabel(cell)})`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openCell(page, routes.desk, cell);

      const durations = await page.evaluate(() => {
        const out: number[] = [];
        for (const el of document.querySelectorAll("button, div, li, tr, span")) {
          const s = getComputedStyle(el);
          for (const v of [s.transitionDuration, s.animationDuration]) {
            for (const part of v.split(",")) {
              const t = part.trim();
              const n = t.endsWith("ms")
                ? parseFloat(t)
                : t.endsWith("s")
                  ? parseFloat(t) * 1000
                  : 0;
              if (n > 0) out.push(n);
            }
          }
        }
        return out;
      });

      expect(durations.length, "no animated elements were found to check").toBeGreaterThan(10);
      const slowest = Math.max(...durations);
      expect(
        slowest,
        `the slowest transition or animation is still ${slowest}ms under reduced motion`,
      ).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("2.5.7 dragging movements, new in WCAG 2.2", () => {
  /**
   * Placement is the one surface that uses drag and drop, and the criterion allows it as
   * long as the same movement is possible without dragging.
   *
   * Both affordances are rendered under the same gate - `canReorder`, which is
   * `canEdit && seedsLocked && !hasMatches` - and the non-drag alternative is two buttons per
   * row labelled "Move <name> up one seed" and "Move <name> down one seed". The invariant
   * holds structurally, because a row cannot be draggable without also carrying the buttons.
   * What this test adds is a check that survives a later refactor moving one of them out of
   * that gate.
   */
  // The affordance only exists for an editor whose seeds are locked, so the session is a
  // prerequisite this spec *supplies* rather than waits for: the mock already serves the
  // seeded entrants the gate needs. Because the prerequisite is therefore never missing,
  // the check below is a hard assertion - a zero result means the gate broke, not that
  // there was nothing to look at.
  test.use({ appMock: { preset: "layout", role: "admin" } });

  test("every draggable row keeps a non-drag alternative", async ({ page }) => {
    await openCell(page, routes.placement, MATRIX_CELLS[0]!);

    const result = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('tr[draggable="true"]')];
      return {
        draggable: rows.length,
        withoutAlternative: rows.filter(
          (row) => row.querySelectorAll("button[aria-label]").length < 2,
        ).length,
      };
    });

    expect(
      result.draggable,
      "no draggable row rendered although the session and the seeded entrants are both present",
    ).toBeGreaterThan(0);

    expect(
      result.withoutAlternative,
      `${result.withoutAlternative} of ${result.draggable} draggable rows offer no non-drag alternative`,
    ).toBe(0);
  });
});

/**
 * The toasts, which no sweep can reach.
 *
 * Axe reads whatever is on the page at the moment it runs, and a toast only exists after an
 * action - so the palette behind every toast this app raises had never been measured. Sonner's
 * own error pair sits at 4.38:1, under the floor, and it was found only because a page-load
 * notice happened to put one in front of the `/tournaments/new` sweep.
 *
 * `styles.css` now carries this app's `--danger-*` and `--success-*` pairs for the two types it
 * raises. Both halves of that are asserted here: the ratio, and the *mechanism* - that what the
 * toast paints is our token rather than sonner's. A sonner upgrade that renames one of those
 * variables would drop the override silently and restore the inaccessible colour, and only the
 * second assertion would catch it.
 */
interface MeasuredToast {
  type: string | null;
  ratio: number | null;
  fill: number[];
  ink: number[] | null;
  surface: number[] | null;
  foreground: number[] | null;
}

const MEASURE_TOAST = `
  (() => {
    ${COLOUR_HELPERS}
    const toast = document.querySelector("[data-sonner-toast]");
    if (!toast) return null;
    const type = toast.getAttribute("data-type");
    const title = toast.querySelector("[data-title]") ?? toast;
    const own = toRgb(getComputedStyle(toast).backgroundColor);
    const back = behind(toast);
    // behind() starts at the parent, so the element's own fill is laid over its result.
    const fill = own ? over(own, [back[0], back[1], back[2], 1]) : back;
    const ink = toRgb(getComputedStyle(title).color);
    const root = getComputedStyle(document.documentElement);
    const token = (name) => {
      const c = toRgb(root.getPropertyValue(name).trim());
      return c ? [c[0], c[1], c[2]] : null;
    };
    const family = type === "error" ? "danger" : "success";
    return {
      type,
      ratio: ink ? ratio(ink, fill) : null,
      fill: [fill[0], fill[1], fill[2]],
      ink: ink ? [ink[0], ink[1], ink[2]] : null,
      surface: token("--" + family + "-surface"),
      foreground: token("--" + family + "-foreground"),
    };
  })()
`;

test.describe("1.4.3 text contrast, on the toasts", () => {
  // "Work in this one" is offered to a caller whose pointer names something else, so the
  // fixture has to serve a caller who is working elsewhere.
  test.use({ appMock: { preset: "layout", role: "user", pointer: null } });

  const measure = async (page: Page): Promise<MeasuredToast> => {
    await expect(page.locator("li[data-sonner-toast]").last()).toBeVisible();
    const measured = (await page.evaluate(MEASURE_TOAST)) as MeasuredToast | null;
    expect(measured, "the toast vanished before it could be measured").not.toBeNull();
    return measured as MeasuredToast;
  };

  test("an act that landed says so in the success pair, above 4.5:1", async ({ page }) => {
    await openCell(page, routes.myTournaments, MATRIX_CELLS[0]!);
    await page.getByRole("button", { name: /work in this one/i }).first().click();

    const toast = await measure(page);
    expect(toast.type).toBe("success");
    expect(toast.fill).toEqual(toast.surface);
    expect(toast.ink).toEqual(toast.foreground);
    expect(
      toast.ratio,
      `the success toast reads at ${toast.ratio}:1 against its own fill`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("a refusal says so in the danger pair, above 4.5:1", async ({ page }) => {
    // The one write this page makes, refused. Registered after the fixture's own handlers,
    // which Playwright resolves last-first, so this route wins.
    await page.route("**/rest/v1/rpc/set_current_tournament", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Could not switch tournament" }),
      }),
    );

    await openCell(page, routes.myTournaments, MATRIX_CELLS[0]!);
    await page.getByRole("button", { name: /work in this one/i }).first().click();

    const toast = await measure(page);
    expect(toast.type).toBe("error");
    expect(toast.fill).toEqual(toast.surface);
    expect(toast.ink).toEqual(toast.foreground);
    expect(
      toast.ratio,
      `the error toast reads at ${toast.ratio}:1 against its own fill`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
