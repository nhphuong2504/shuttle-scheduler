import { expect, test } from "./fixtures/app";
import { MATRIX_CELLS, openCell } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";

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
