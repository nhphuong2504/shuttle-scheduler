import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";

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
  "/",
  "/matches",
  "/placement-schedule",
  "/placement",
  "/draws",
  "/knockout",
  "/registration",
  "/setup",
  "/staff",
];

const DENSITIES = ["comfortable", "compact"] as const;

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

async function atDensity(page: Page, density: (typeof DENSITIES)[number], route: string) {
  await page.goto(route);
  await page.evaluate((d) => localStorage.setItem("shuttlenet.density", d), density);
  await page.goto(route, { waitUntil: "networkidle" });
  // Confirm the density actually took effect, so a route that silently ignored the
  // preference cannot make this suite pass while measuring the wrong scale.
  await expect(page.locator("html")).toHaveAttribute("data-density", density);
  await page.waitForTimeout(150);
}

for (const density of DENSITIES) {
  test.describe(`rendered type at ${density} density`, () => {
    // A large desktop monitor: the size the design was tuned against.
    test.use({ viewport: { width: 2560, height: 1440 } });

    for (const route of ROUTES) {
      test(`${route} renders nothing below 12px`, async ({ page }) => {
        await atDensity(page, density, route);
        const rows = await measure(page);
        // A page that rendered nothing would pass vacuously.
        expect(rows.length, `${route} rendered no text at all`).toBeGreaterThan(3);

        const small = rows.filter((r) => r.px < 12);
        const unique = [
          ...new Map(small.map((r) => [`${r.px}|${r.tag}|${r.cls}|${r.text}`, r])).values(),
        ];
        expect(
          unique.map((r) => `${r.px}px <${r.tag}> "${r.text}" class="${r.cls}"`),
          `${route} has text below the 12px floor at ${density}`,
        ).toEqual([]);
      });
    }
  });
}

test.describe("density changes real sizes, not just the attribute", () => {
  test.use({ viewport: { width: 2560, height: 1440 } });

  test("the Desk's identify tier is 13px compact and 14px comfortable", async ({ page }) => {
    // Pins the actual values from the approved scale. If someone edits the token
    // values, this fails rather than the change going unnoticed.
    await atDensity(page, "compact", "/");
    expect(
      await page.evaluate(() => {
        const el = document.querySelector(".text-t2");
        return el ? Number.parseFloat(getComputedStyle(el).fontSize) : null;
      }),
    ).toBe(13);

    await atDensity(page, "comfortable", "/");
    expect(
      await page.evaluate(() => {
        const el = document.querySelector(".text-t2");
        return el ? Number.parseFloat(getComputedStyle(el).fontSize) : null;
      }),
    ).toBe(14);
  });

  test("a dense list row is taller in comfortable than in compact", async ({ page }) => {
    // Row height is the other half of density: the point of Compact is more rows on
    // screen, not smaller type, so this asserts the rows actually move.
    const rowHeight = async () =>
      page.evaluate(() =>
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--row-height"),
        ),
      );

    await atDensity(page, "compact", "/");
    const compact = await rowHeight();
    await atDensity(page, "comfortable", "/");
    const comfortable = await rowHeight();

    expect(compact).toBeLessThan(comfortable);
  });
});
