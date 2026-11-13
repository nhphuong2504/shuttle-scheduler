import { expect, test } from "./fixtures/app";
import { MATRIX_CELLS, openCell } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";
import { deskFixture } from "./fixtures/desk-mock";
import { installAppMock } from "./fixtures/app-mock";
import AxeBuilder from "@axe-core/playwright";
import { WCAG_TAGS } from "./fixtures/matrix";

/**
 * The reader's pages fit the screens the app is read on.
 *
 * Layout is the one thing jsdom cannot see, and these pages were once correct in every unit
 * test while a 320px phone and a phone held sideways showed no match at all without
 * scrolling: the title rows above the first court were taller than the screen. So each size
 * here asserts the first thing a spectator came for is on screen, and that nothing scrolls
 * sideways. The sizes are the ones the rest of the suite holds the app to: 320 for reflow,
 * a phone on its side, and the 1366×768 working viewport.
 */

const SIZES = [
  { name: "a 320px phone", width: 320, height: 640 },
  { name: "a phone held sideways", width: 844, height: 390 },
  { name: "a 1366×768 laptop", width: 1366, height: 768 },
] as const;

for (const size of SIZES) {
  test.describe(`on ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("Now shows a court in play without scrolling", async ({ page }) => {
      await openCell(page, routes.now, MATRIX_CELLS[0]!);

      const court = page.locator('section[aria-labelledby="now-on-court"] li').first();
      await expect(court).toBeVisible();
      const box = await court.boundingBox();
      expect(box, "the first court has a box").not.toBeNull();
      expect(box!.y, "the first court starts inside the first screen").toBeLessThan(
        size.height - 40,
      );
      await expectNoSidewaysScroll(page);
    });

    test("Schedule draws rows on a phone and a table on a desktop", async ({ page }) => {
      await openCell(page, routes.timetable, MATRIX_CELLS[0]!);

      const table = page.getByRole("main").getByRole("table").first();
      if (size.width >= 1024) {
        await expect(table).toBeVisible();
        await expect(table.getByRole("columnheader", { name: "Court" })).toBeVisible();
      } else {
        await expect(page.getByRole("main").getByRole("table")).toHaveCount(0);
        await expect(page.getByRole("main").getByRole("listitem").first()).toBeVisible();
      }
      await expectNoSidewaysScroll(page);
    });
  });
}

test.describe("on a laptop or a screen on the wall", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("Now is one screen tall, and its lists scroll inside it", async ({ page }) => {
    await openCell(page, routes.now, MATRIX_CELLS[0]!);

    // The title's row, then the page wrapper that holds it and the board together.
    const board = page.getByRole("main").locator("h1").locator("xpath=../../..");
    const height = await board.evaluate((el) => el.getBoundingClientRect().height);
    expect(Math.abs(height - 768), "the Now board is the viewport's height").toBeLessThan(2);

    const lists = page.locator("#now-up-next").locator("xpath=ancestor::section/..");
    await expect(lists).toHaveCSS("overflow-y", "auto");
  });
});

async function expectNoSidewaysScroll(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
}

// Keep real match shapes; a forced completion can leave unplayed rows.
for (const status of ["upcoming", "in_progress", "completed"] as const) {
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 1366, height: 650 },
    { width: 1800, height: 900 },
  ]) {
    test(`Now ${status} remains readable at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await installAppMock(page, { status, role: null });
      const tables = deskFixture("layout", "user", status).tables;
      const rows = tables["tier_draw_matches"] as Record<string, unknown>[];
      const populated = rows.filter((row) => !row.is_bye && row.entrant_a_id && row.entrant_b_id);
      const matches =
        status === "upcoming"
          ? populated.map((row) => ({
              ...row,
              status: "scheduled",
              started_at: null,
              ended_at: null,
              games: [],
            }))
          : populated.map((row, index) => ({
              ...row,
              status: status === "completed" && index === 0 ? "scheduled" : "reported",
              games: [{ a: 21, b: 14 }],
            }));
      await page.route("**/rest/v1/tournaments?*", (route) =>
        route.fulfill({ json: tables["tournaments"] }),
      );
      await page.route("**/rest/v1/tier_draw_matches?*", (route) =>
        route.fulfill({ json: matches }),
      );
      if (status === "completed") {
        const entrants = tables["placement_entrants"] as { id: string; team_id: string }[];
        const teams = tables["teams"] as Record<string, unknown>[];
        const category = (tables["categories"] as Record<string, unknown>[])[0]!;
        const draw = (tables["tier_draws"] as Record<string, unknown>[])[0]!;
        const categories = Array.from({ length: 5 }, (_, i) => ({
          ...category,
          id: `category-${i}`,
          code: `E${i}`,
          name: [
            "Men's Singles",
            "Women's Singles",
            "Men's Doubles",
            "Women's Doubles",
            "Mixed Doubles",
          ][i],
        }));
        const winnerTeams: Record<string, unknown>[] = [];
        const winnerEntrants: Record<string, unknown>[] = [];
        const draws = categories.flatMap((entry, i) =>
          ["A", "B", "C", "D"].map((tier, j) => ({
            ...draw,
            id: i === 0 && j === 0 ? draw.id : `draw-${i}-${tier}`,
            category_id: entry.id,
            tier,
            champion_id: (() => {
              const index = i * 4 + j;
              const entrant = entrants[index % entrants.length]!;
              const team = teams.find((row) => row.id === entrant.team_id)!;
              const teamId = `winner-team-${index}`;
              const entrantId = `winner-${index}`;
              winnerTeams.push({
                ...team,
                id: teamId,
                category_id: entry.id,
                ...(i < 2 ? { player_2_id: null } : {}),
              });
              winnerEntrants.push({
                ...entrant,
                id: entrantId,
                team_id: teamId,
                category_id: entry.id,
              });
              return entrantId;
            })(),
          })),
        );
        await page.route("**/rest/v1/categories?*", (route) => route.fulfill({ json: categories }));
        await page.route("**/rest/v1/tier_draws?*", (route) => route.fulfill({ json: draws }));
        await page.route("**/rest/v1/teams?*", (route) =>
          route.fulfill({ json: [...teams, ...winnerTeams] }),
        );
        await page.route("**/rest/v1/placement_entrants?*", (route) =>
          route.fulfill({ json: [...entrants, ...winnerEntrants] }),
        );
      }
      await openCell(page, routes.now, MATRIX_CELLS[0]!);
      await expect(page.locator("#now-on-court")).toBeVisible();
      const lists = page.locator("#now-up-next").locator("xpath=ancestor::section/..");
      await expect(lists).not.toHaveCSS("overflow-y", "auto");
      if (status === "completed") {
        await expect(
          page.getByRole("heading", { name: "Draw champions", exact: true }),
        ).toBeVisible();
        const champions = page.getByRole("region", { name: "Draw champions", exact: true });
        await champions.screenshot({ path: `test-results/champions-${viewport.width}.png` });
        await expect(champions.getByRole("definition")).toHaveCount(20);
        await expect(champions.getByRole("definition").first().locator("span")).toHaveCount(1);
        const first = champions.getByRole("definition").nth(8);
        const names = first.locator(":scope > span");
        await expect(names).toHaveCount(2);
        const [a, b] = await Promise.all([names.nth(0).boundingBox(), names.nth(1).boundingBox()]);
        if (viewport.width < 640) expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height);
        if (viewport.width >= 1024) {
          const cells = champions.getByRole("definition");
          const boxes = await Promise.all(
            [0, 1, 2, 3].map((index) => cells.nth(index).boundingBox()),
          );
          expect(new Set(boxes.map((box) => Math.round(box!.x))).size).toBe(1);
          expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y);
          const summary = await champions.boundingBox();
          expect(summary!.height, "five events stay compact even with long names").toBeLessThan(
            650,
          );
        }
        await expect(page.getByText("Play has finished", { exact: true })).toBeVisible();
        await expect(page.locator("#now-up-next").locator("..").getByRole("listitem")).toHaveCount(
          0,
        );
      }
      if (status === "upcoming") {
        await expect(page.getByText("Play has not started", { exact: true })).toBeVisible();
      }
      await expectNoSidewaysScroll(page);
      expect((await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: `test-results/now-${status}-${viewport.width}.png`,
        fullPage: true,
      });
    });
  }
}

test("Now waits for every required read, then offers retry on a failed first load", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.route("**/rest/v1/tournament_days?*", async (route) => {
    await held;
    if (fail) await route.fulfill({ status: 500, json: { message: "Unavailable" } });
    else await route.fulfill({ json: deskFixture("layout").tables["tournament_days"] });
  });
  await page.goto(routes.now);
  await expect(page.getByRole("status", { name: "Loading the courts" })).toBeVisible();
  await expect(page.locator("#now-on-court")).toHaveCount(0);
  release();
  await expect(page.getByText("Could not load the tournament", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator("#now-on-court")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("#now-on-court")).toBeVisible();
});

test("Now switches to an empty day and back without carrying live courts across days", async ({
  page,
}) => {
  const day = (deskFixture("layout").tables["tournament_days"] as Record<string, unknown>[])[0]!;
  const nextDate = new Date(`${day.date as string}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  await page.route("**/rest/v1/tournament_days?*", (route) =>
    route.fulfill({ json: [day, { ...day, id: "empty-day", day_number: 2, date: nextDate.toISOString().slice(0, 10) }] }),
  );
  await openCell(page, routes.now, MATRIX_CELLS[0]!);
  const days = page.getByRole("group", { name: "Day", exact: true }).getByRole("button");
  const courts = page.locator('section[aria-labelledby="now-on-court"] li');
  await expect(courts.first()).toBeVisible();
  await days.nth(1).click();
  await expect(days.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(courts).toHaveCount(0);
  await expect(
    page.getByText("Nothing else is scheduled for this day.", { exact: true }),
  ).toBeVisible();
  await days.nth(0).click();
  await expect(courts.first()).toBeVisible();
});

for (const status of ["upcoming", "in_progress", "completed"] as const) {
  test(`Now handles an unconfigured empty ${status} tournament`, async ({ page }) => {
    await installAppMock(page, { preset: "prebuild", status, role: null });
    await page.route("**/rest/v1/tournament_days?*", (route) => route.fulfill({ json: [] }));
    await openCell(page, routes.now, MATRIX_CELLS[0]!);
    await expect(page.locator("#now-on-court")).toBeVisible();
    await expect(page.getByRole("group", { name: "Day", exact: true })).toHaveCount(0);
    await expect(page.locator("#now-on-court").locator("..").getByRole("listitem")).toHaveCount(0);
    await expect(page.getByText("No results yet for this day.", { exact: true })).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
}

test("Now retains its courts when a background read fails and recovers on retry", async ({
  page,
}) => {
  await openCell(page, routes.now, MATRIX_CELLS[0]!);
  const courts = page.locator('section[aria-labelledby="now-on-court"] li');
  const count = await courts.count();
  expect(count).toBeGreaterThan(0);
  let fail = true;
  await page.route("**/rest/v1/tournament_days?*", (route) =>
    fail
      ? route.fulfill({ status: 500, json: { message: "Unavailable" } })
      : route.fulfill({ json: deskFixture("layout").tables["tournament_days"] }),
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.dispatchEvent(new Event("visibilitychange"));
    delete (document as unknown as Record<string, unknown>)["visibilityState"];
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByText("Could not refresh. Showing what was last loaded.")).toBeVisible({
    timeout: 20000,
  });
  await expect(courts).toHaveCount(count);
  fail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Could not refresh. Showing what was last loaded.")).toHaveCount(0);
  await expect(courts).toHaveCount(count);
});
