import { expect, test } from "./fixtures/app";
import { routes } from "./fixtures/routes";
import { deskFixture } from "./fixtures/desk-mock";

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
  // The operator's subtitle is the marker; a reader is told only when and where matches are.
  test.use({ appMock: { preset: "layout", role: "admin" } });

  test("renders the placement builder, and not the day-by-day planner", async ({ page }) => {
    await page.goto(routes.schedule, { waitUntil: "networkidle" });

    await expect(page.getByText(PLACEMENT_VIEW, { exact: false })).toBeVisible();
    await expect(page.getByText(DAY_PLANNER_VIEW, { exact: false })).toHaveCount(0);
  });

  /**
   * The preview is where an organiser accepts or refuses a replan, so what it has to show is the
   * *change*: the finish they have against the finish they would get, and the moves grouped by
   * the day they land on. It used to show only the proposed schedule.
   */
  test("previews the change as a comparison, with its moves grouped by day", async ({ page }) => {
    await page.goto(routes.schedule, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Rebuild schedule|Build schedule/ }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("Rebuild preview", { exact: true })).toBeVisible();
    // The dry-run promise is the property the whole panel is built on.
    await expect(dialog.getByText(/Nothing is written until you apply/)).toBeVisible();
    // A verdict line, not a plan dump: it says what would move.
    await expect(dialog.getByText(/would move|Nothing would move/)).toBeVisible();
    // The moves are grouped under their day, and carry both the old and the new value.
    await expect(dialog.getByRole("heading", { name: /Oct/ })).toBeVisible();
    await expect(dialog.getByRole("columnheader", { name: "Shift" })).toBeVisible();
    // The refusal is named beside the control it disables rather than only in the body.
    await expect(dialog.getByRole("button", { name: "Keep current schedule" })).toBeEnabled();
  });

  /**
   * The dialog is capped at 85vh with `overflow-hidden`, so a body that will not shrink pushes the
   * footer past the bottom edge - the buttons became unreachable and part of the plan was cut.
   * Measured rather than eyeballed: the Apply button has to be inside the dialog and on screen.
   */
  test("keeps its buttons on screen when the plan is taller than the dialog", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 480 });
    await page.goto(routes.schedule, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Rebuild schedule|Build schedule/ }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const apply = dialog.getByRole("button", { name: "Apply rebuild" });
    await expect(apply).toBeVisible();

    const dialogBox = await dialog.boundingBox();
    const applyBox = await apply.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(applyBox).not.toBeNull();
    // Inside the dialog and inside the viewport: the bug was that the footer escaped both.
    expect(applyBox!.y + applyBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);
    expect(applyBox!.y + applyBox!.height).toBeLessThanOrEqual(480);
    // Full height, not squashed into a strip: a collapsed footer would pass the two checks above.
    expect(applyBox!.height).toBeGreaterThanOrEqual(40);

    // The body scrolls instead of being cut: its content is taller than its box.
    const scrolls = await dialog.evaluate((el) => {
      const body = el.querySelector<HTMLElement>("[data-preview-body]");
      return body ? { client: body.clientHeight, scroll: body.scrollHeight } : null;
    });
    expect(scrolls).not.toBeNull();
    expect(scrolls!.scroll).toBeGreaterThan(scrolls!.client);
  });

  /**
   * A four-column table does not fit a phone, and the version that tried clipped Court and Shift
   * off the right edge. Below `sm` each move is one block instead.
   */
  test("shows each move as a block on a phone rather than a clipped table", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(routes.schedule, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Rebuild schedule|Build schedule/ }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("columnheader", { name: "Shift" })).toBeHidden();
    // The facts the table would have carried are on the row itself.
    const row = dialog.getByRole("listitem").filter({ hasText: /Court \d+ → Court \d+/ });
    await expect(row).toBeVisible();
    await expect(row.getByText(/^\+\d+ min$/)).toBeVisible();
  });

  test("shows both placement rounds in progress and explains the remaining feeder slots", async ({
    page,
  }) => {
    const fixture = deskFixture("layout", "admin");
    const all = fixture.tables["placement_entrants"] as {
      id: string;
      category_id: string;
      tournament_id: string;
      seed: number;
    }[];
    const field = all
      .slice(0, 8)
      .map((e, i) => ({ ...e, category_id: all[0]!.category_id, seed: i + 1, tier: null }));
    expect(field).toHaveLength(8);
    const r1 = Array.from({ length: 4 }, (_, i) => ({
      id: `source-${i + 1}`,
      tournament_id: field[0]!.tournament_id,
      category_id: field[0]!.category_id,
      stage: "round1",
      generation_key: `r1-${i + 1}`,
      entrant_a_id: field[i]!.id,
      entrant_b_id: field[i + 4]!.id,
      winner_id: i % 2 === 0 ? field[i]!.id : null,
      status: i % 2 === 0 ? "reported" : "scheduled",
      games: [],
      prerequisite_ids: [],
      scheduled_time: null,
      court_id: null,
      started_at: null,
      ended_at: null,
      reported_time: null,
      is_makeup: false,
      is_crossover: false,
    }));
    const matches = [
      ...r1,
      ...[0, 4].map((offset, i) => ({
        ...r1[0]!,
        id: `child-${i}`,
        stage: "round2",
        generation_key: i === 0 ? "r2-1" : "r2-3",
        entrant_a_id: field[offset]!.id,
        entrant_b_id: field[offset + 2]!.id,
        status: "scheduled",
        winner_id: null,
        prerequisite_ids: ["source-1", "source-3"],
      })),
    ];
    for (const [table, rows] of [
      ["placement_entrants", field],
      ["placement_matches", matches],
      ["tier_draws", []],
      ["tier_draw_matches", []],
    ] as const) {
      await page.route(`**/rest/v1/${table}?*`, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) }),
      );
    }
    await page.goto(routes.schedule, { waitUntil: "networkidle" });
    const panel = page.locator("section", {
      has: page.getByRole("heading", { name: "Stage progress" }),
    });
    const first = panel
      .getByRole("listitem")
      .filter({ has: page.getByText("Round 1", { exact: true }) });
    const second = panel
      .getByRole("listitem")
      .filter({ has: page.getByText("Round 2", { exact: true }) });
    await expect(first.getByText("In progress", { exact: true })).toHaveCount(1);
    await expect(second.getByText("In progress", { exact: true })).toHaveCount(1);
    await second.getByText("2 awaiting opponents", { exact: true }).click();
    await expect(
      second.getByText("Winner of Round 1 match 2 vs Winner of Round 1 match 4", { exact: false }),
    ).toBeVisible();
    await expect(
      second.getByText("Loser of Round 1 match 2 vs Loser of Round 1 match 4", { exact: false }),
    ).toBeVisible();
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
