import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";
import { routes } from "./fixtures/routes";

/**
 * The 12px floor, measured on rendered output.
 *
 * The static tests in `src/lib/design/tokens.test.ts` prove no *class* asks for a
 * size below 12px and no *declaration* in the stylesheet does either. Neither can
 * see what a browser actually computes: inherited sizes, styles from a UI library,
 * and specificity interactions all happen after those checks pass.
 *
 * That gap was real. The stylesheet declared `font-size: 0.625rem` on table
 * headers - 10px, on every schedule table - and no class-level search could find
 * it. This file is the check that did, and it is the reason the floor is now
 * enforced where it can actually be observed.
 *
 * Kept as a rendered test rather than the throwaway script it started as, because a
 * floor that is only verified once is not a floor.
 */

const ROUTES = [
  routes.tournament,
  routes.desk,
  routes.scores,
  routes.schedule,
  routes.placement,
  routes.draws,
  routes.knockout,
  routes.entries,
  routes.settings,
  routes.access,
  routes.registrations,
  // The non-scoped surfaces, for the same reason the shared matrix lists them: the 12px
  // floor is a property of every page the app renders, not of the pages in the nav.
  routes.home,
  routes.explore,
  routes.myTournaments,
  routes.newTournament,
];

/** Every painted text run, with the size the browser resolved for it. */
function measure(page: Page) {
  return page.evaluate(() => {
    const rows: { px: number; tag: string; cls: string; text: string }[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const own = [...el.childNodes].filter(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
      );
      if (!own.length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      rows.push({
        px: Number.parseFloat(cs.fontSize),
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute("class") ?? "").slice(0, 100),
        text: own
          .map((n) => (n.textContent ?? "").trim())
          .join(" ")
          .slice(0, 40),
      });
    }
    return rows;
  });
}

async function atRoute(page: Page, route: string) {
  await page.goto(route, { waitUntil: "networkidle" });
  await page.waitForTimeout(150);
}

test.describe("rendered type", () => {
  // A large desktop monitor: the size the design was tuned against.
  test.use({ viewport: { width: 2560, height: 1440 } });

  for (const route of ROUTES) {
    test(`${route} renders nothing below 12px`, async ({ page }) => {
      await atRoute(page, route);
      const rows = await measure(page);
      // A page that rendered nothing would pass vacuously.
      expect(rows.length, `${route} rendered no text at all`).toBeGreaterThan(3);

      const small = rows.filter((r) => r.px < 12);
      const unique = [
        ...new Map(small.map((r) => [`${r.px}|${r.tag}|${r.cls}|${r.text}`, r])).values(),
      ];
      expect(
        unique.map((r) => `${r.px}px <${r.tag}> "${r.text}" class="${r.cls}"`),
        `${route} has text below the 12px floor`,
      ).toEqual([]);
    });
  }
});

test.describe("the type scale renders at its approved values", () => {
  test.use({ viewport: { width: 2560, height: 1440 } });

  test("the identify tier is 14px", async ({ page }) => {
    // Pins the actual value from the approved scale. If someone edits the token value,
    // this fails rather than the change going unnoticed.
    await atRoute(page, routes.desk);
    expect(
      await page.evaluate(() => {
        const el = document.querySelector(".text-t2");
        return el ? Number.parseFloat(getComputedStyle(el).fontSize) : null;
      }),
    ).toBe(14);
  });

  test("the row height is the 44px the scale declares", async ({ page }) => {
    // Row height is the other half of the scale, and it is shared rather than restated
    // per table: the schedule and the score list must not drift apart. Read from the
    // computed custom property, which is the value every cell inherits.
    await atRoute(page, routes.desk);
    const rowHeight = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--row-height").trim(),
    );
    expect(rowHeight).toBe("2.75rem");
  });
});
