import { expect, test } from "./fixtures/app";
import { routes } from "./fixtures/routes";

/**
 * One schedule route, two scheduling views, chosen by the stored format.
 *
 * `/schedule` and `/placement-schedule` used to be two routes, one per view, and the URL was
 * therefore the thing that decided which engine you got. They are one route now, and the
 * format decides - which means the *format* is what has to be varied to reach each view.
 *
 * That distinction is easy to lose. The rest of the suite runs against one fixture tournament
 * (a two-round placement event), so the day-by-day planner would silently stop being rendered
 * anywhere in the suite; a page nothing renders is a page nothing measures, and the a11y,
 * typography and layout sweeps would all keep passing while covering one view instead of two.
 * Hence the `format` override on the mock, and this file: it is the only place that reaches
 * the round-robin planner, so it is also the only place that can notice it breaking.
 */

/**
 * Markers that identify each view, rather than merely being present on both.
 *
 * The two views share a title ("Court schedule"), so the subtitle is what distinguishes
 * them - which is honest, because the subtitle is the one sentence that says what the page
 * does with the tournament's court time.
 */
const PLACEMENT_VIEW = "One running order for the whole tournament";
const DAY_PLANNER_VIEW = "Build each day of the running order";

test.describe("the placement format gets the placement scheduler", () => {
  test("renders the placement builder, and not the day-by-day planner", async ({ page }) => {
    await page.goto(routes.schedule, { waitUntil: "networkidle" });

    await expect(page.getByText(PLACEMENT_VIEW, { exact: false })).toBeVisible();
    await expect(page.getByText(DAY_PLANNER_VIEW, { exact: false })).toHaveCount(0);
  });
});

test.describe("the round-robin format gets the day-by-day planner", () => {
  test.use({ appMock: { preset: "layout", role: "admin", format: "round_robin" } });

  test("renders the day planner, and not the placement builder", async ({ page }) => {
    await page.goto(routes.schedule, { waitUntil: "networkidle" });

    await expect(page.getByText(DAY_PLANNER_VIEW, { exact: false })).toBeVisible();
    await expect(page.getByText(PLACEMENT_VIEW, { exact: false })).toHaveCount(0);
  });

  test("is reached from both of the old addresses, since neither names a format", async ({
    page,
  }) => {
    // The two legacy slugs collapse onto the one route, and each still resolves on the
    // format rather than on which address it came in through.
    for (const from of ["/schedule", "/placement-schedule"]) {
      await page.goto(from, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new RegExp(`${routes.schedule.replaceAll("$", "\\$")}$`));
      await expect(page.getByText(DAY_PLANNER_VIEW, { exact: false })).toBeVisible();
    }
  });
});
