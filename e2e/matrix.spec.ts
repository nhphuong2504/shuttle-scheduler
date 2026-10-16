import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";

import { cellLabel, MATRIX_CELLS, openCell, ROUTES, WCAG_TAGS } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";

/**
 * P4: the infrastructure matrix, validated.
 *
 * Three properties are checked against every route, because each one has already been
 * a blind spot in turn:
 *
 *   contrast headroom   the axe gate catches a *failure*; it cannot see a pair that
 *                       passes at 4.51:1 and is therefore one token tweak from breaking
 *   focus visibility    whether a control is *reachable* says nothing about whether you
 *                       can see where you are, and the focus ring is drawn in a pseudo
 *                       state that only exists while a key is held
 *   layout integrity    whether the text *fits*, which no rule engine checks and no class
 *                       name proves
 *
 * This file deliberately does not sweep match statuses, court states or urgency
 * treatments. Those are P6's work, after P5 rewrites the vocabulary - sweeping them now
 * would pin the behaviour that is about to change.
 *
 * The working viewport is 1366x768 for every sweep. That is the stated minimum device,
 * so it is the width at which "does it fit" has a meaningful answer; a layout that only
 * fits at 2560 is not responsive, it is just lucky.
 */
const VIEWPORT = { width: 1366, height: 768 };

test.use({ viewport: VIEWPORT });

/* -------------------------------------------------------------------------- *
 * Contrast headroom
 * -------------------------------------------------------------------------- */

/**
 * Every pair axe can resolve, not just the failing ones.
 *
 * Reading `passes` as well as `violations` is the whole point: a violation list answers
 * "is anything broken", while the passing nodes answer "how close is anything to
 * breaking". The distinction found a real fact about this system - the tightest pair it
 * can produce is 4.6:1 against a 4.5:1 requirement, a margin of 0.1, on the translucent
 * primary chip. It passes, but it passes by 0.1, and nothing would have reported that
 * until it stopped passing.
 */
const MIN_MARGIN = 0.05;

type Pair = { ratio: number; required: number; margin: number; where: string };

async function contrastPairs(page: Page): Promise<Pair[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const rule = [...results.passes, ...results.violations].find((r) => r.id === "color-contrast");
  if (!rule) return [];

  const pairs: Pair[] = [];
  for (const node of rule.nodes) {
    for (const check of [...node.any, ...node.all]) {
      const data = check.data as Record<string, unknown>;
      const ratio = Number(data["contrastRatio"]);
      if (!Number.isFinite(ratio)) continue;
      const required = parseFloat(String(data["expectedContrastRatio"] ?? "4.5"));
      pairs.push({
        ratio,
        required,
        margin: Number((ratio - required).toFixed(2)),
        where: `${node.target.join(" ").slice(0, 70)} (${String(data["fgColor"])} on ${String(data["bgColor"])})`,
      });
    }
  }
  return pairs;
}

test.describe("contrast headroom across the matrix", () => {
  // This sweep visits all 12 routes in one test, so it needs a budget that reflects that
  // rather than the 30s default sized for a single page. It is not a slow test - it is 12
  // normal tests' worth of work reported as one, because the assertion is about the cell's
  // tightest pair and that is only meaningful once every route in the cell has been read.
  test.describe.configure({ timeout: 240_000 });

  for (const cell of MATRIX_CELLS) {
    test(`every pair clears its requirement (${cellLabel(cell)})`, async ({ page }) => {
      const pairs: Pair[] = [];
      for (const route of ROUTES) {
        await openCell(page, route, cell);
        pairs.push(...(await contrastPairs(page)));
      }

      // A cell that measured nothing is a broken cell, not a clean one. Without this the
      // test would pass vacuously if axe stopped resolving contrast, which is exactly the
      // failure mode that would make every downstream assertion meaningless.
      expect(pairs.length, `no contrast pairs measured in ${cellLabel(cell)}`).toBeGreaterThan(50);

      const failing = pairs.filter((pair) => pair.margin < 0);
      expect(
        failing,
        `pairs below their required ratio: ${failing.map((f) => `${f.ratio}:1 ${f.where}`).join(" | ")}`,
      ).toEqual([]);

      // The headroom floor. Not a target - the current minimum is 0.1 - but a floor, so a
      // change that lands a pair exactly on the line fails here rather than silently
      // becoming the next P3.
      const tightest = [...pairs].sort((a, b) => a.margin - b.margin).slice(0, 3);
      for (const pair of tightest) {
        expect(
          pair.margin,
          `only ${pair.margin} of margin on ${pair.ratio}:1 needing ${pair.required}:1 — ${pair.where}`,
        ).toBeGreaterThanOrEqual(MIN_MARGIN);
      }

      console.log(
        `${cellLabel(cell)}: ${pairs.length} pairs, tightest ${tightest
          .map((p) => `${p.ratio}:1(+${p.margin})`)
          .join(", ")}`,
      );
    });
  }
});

/* -------------------------------------------------------------------------- *
 * Focus visibility
 * -------------------------------------------------------------------------- */

/**
 * Tabs the whole page and checks every stop is visibly focused.
 *
 * `:focus-visible` only matches while a keyboard is driving, so a Tab sweep is the only
 * way to reach the state being checked - a programmatic `.focus()` does not trigger it,
 * and neither does a click. Checking `outline` and `box-shadow` together covers both
 * conventions in this codebase: the shadcn primitives use a `ring` (a box-shadow), while
 * the browser's own controls use an outline.
 */
const MAX_TABS = 45;

type Stop = { tag: string; label: string; cls: string; visible: boolean };

async function tabStops(page: Page): Promise<Stop[]> {
  const stops: Stop[] = [];
  const visited = new Set<string>();

  for (let index = 0; index < MAX_TABS; index += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);

      const outlineWidth = parseFloat(style.outlineWidth) || 0;
      const outlineVisible = style.outlineStyle !== "none" && outlineWidth > 0;
      const shadowVisible = style.boxShadow !== "none" && style.boxShadow !== "";

      return {
        tag: element.tagName.toLowerCase(),
        label: (
          element.getAttribute("aria-label") ??
          element.textContent ??
          element.getAttribute("type") ??
          ""
        )
          .trim()
          .slice(0, 30),
        cls: element.className?.toString().slice(0, 70) ?? "",
        visible: outlineVisible || shadowVisible,
      };
    });

    if (!stop) break;

    // Cycle detection: the tab order wraps back to the start, so revisitng a signature
    // means the sweep is complete. Without it the loop just re-walks the same elements
    // until MAX_TABS and a real failure could be counted several times.
    const signature = `${stop.tag}|${stop.cls}|${stop.label}`;
    if (visited.has(signature)) break;
    visited.add(signature);
    stops.push(stop);
  }

  return stops;
}

test.describe("focus visibility across the matrix", () => {
  for (const cell of MATRIX_CELLS) {
    for (const route of ROUTES) {
      test(`${route} shows a focus indicator on every stop (${cellLabel(cell)})`, async ({
        page,
      }) => {
        await openCell(page, route, cell);
        const stops = await tabStops(page);

        const invisible = stops.filter((stop) => !stop.visible);
        expect(
          invisible,
          `focus reached ${invisible.length} element(s) with no visible indicator: ` +
            invisible.map((s) => `<${s.tag}> "${s.label}" [${s.cls}]`).join(" | "),
        ).toEqual([]);

        // A page with nothing tabbable would pass the assertion above while proving
        // nothing, so the sweep must have reached a meaningful number of controls.
        expect(
          stops.length,
          `${route} exposed only ${stops.length} keyboard stop(s)`,
        ).toBeGreaterThan(2);
      });
    }
  }
});

/* -------------------------------------------------------------------------- *
 * Layout integrity
 * -------------------------------------------------------------------------- */

type LayoutReport = {
  overflow: number;
  clipped: { tag: string; text: string; cls: string; overflow: number }[];
  geometry: { tag: string; x: number; y: number; w: number; h: number }[];
};

/**
 * Wait until the landmark set stops changing.
 *
 * `openCell` waits for network idle, but these routes render their tables from React
 * Query, and a query that resolves just after the network goes quiet adds a landmark on
 * the next paint. Measuring across two separate page loads then compares a settled page
 * against an unsettled one and reports drift that is not there.
 *
 * That is exactly what happened to `/draws` and `/` when the whole suite ran on four
 * workers: "measured no landmarks - expected 3, received 4". Both passed when the same
 * tests ran alone, which is the signature of a race rather than a defect, and a gate that
 * fails for a timing reason is a gate nobody will trust.
 *
 * Polling until the count repeats is the honest fix. It removes the race without
 * weakening the assertion: a page whose landmark set genuinely differs from its settled
 * state still fails, because every measurement is now taken in the same settled state.
 *
 * The count is stashed on `window`, which each `openCell` resets by navigating, so the
 * stability counter cannot leak from one measurement into the next.
 */
async function settleLandmarks(page: Page): Promise<void> {
  const LANDMARKS = "header, main, h1, h2, table";
  await page.waitForFunction(
    (selector) => {
      const count = document.querySelectorAll(selector).length;
      const w = window as unknown as { __landmarks?: { count: number; stable: number } };
      const previous = w.__landmarks;
      w.__landmarks =
        previous && previous.count === count
          ? { count, stable: previous.stable + 1 }
          : { count, stable: 0 };
      // Three consecutive identical readings, 100ms apart.
      return w.__landmarks.stable >= 2;
    },
    LANDMARKS,
    { timeout: 15_000, polling: 100 },
  );
}

/**
 * Measures three things in one pass: whether the page scrolls sideways, whether text is
 * silently cut off, and the geometry of the landmarks.
 *
 * The clipped-text rule is careful about intent. Visible truncation - `text-overflow:
 * ellipsis` - is a deliberate affordance and is excluded, because the reader is told the
 * value is abbreviated. What is reported is an element whose own text is wider than its
 * box while `overflow` is hidden or clipped and no ellipsis is offered: the value is then
 * simply gone, with nothing on screen to say so.
 */
async function measureLayout(page: Page): Promise<LayoutReport> {
  await settleLandmarks(page);
  return page.evaluate(() => {
    const doc = document.documentElement;

    const clipped: LayoutReport["clipped"] = [];
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const style = getComputedStyle(element);
      if (style.overflowX !== "hidden" && style.overflowX !== "clip") continue;
      if (style.textOverflow === "ellipsis") continue;
      // Visually-hidden text is clipped on purpose and still read aloud, so it is not "gone".
      if (element.classList.contains("sr-only")) continue;
      const own = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      if (!own) continue;
      const overflow = element.scrollWidth - element.clientWidth;
      if (overflow > 1) {
        clipped.push({
          tag: element.tagName.toLowerCase(),
          text: own.slice(0, 40),
          cls: element.className?.toString().slice(0, 60) ?? "",
          overflow,
        });
      }
    }

    const geometry: LayoutReport["geometry"] = [];
    for (const element of Array.from(document.querySelectorAll("header, main, h1, h2, table"))) {
      const box = element.getBoundingClientRect();
      geometry.push({
        tag: `${element.tagName.toLowerCase()}${element.className ? "" : ""}`,
        x: Math.round(box.x * 10) / 10,
        y: Math.round(box.y * 10) / 10,
        w: Math.round(box.width * 10) / 10,
        h: Math.round(box.height * 10) / 10,
      });
    }

    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      clipped,
      geometry,
    };
  });
}

test.describe("layout integrity across the matrix", () => {
  for (const cell of MATRIX_CELLS) {
    for (const route of ROUTES) {
      test(`${route} fits its viewport without clipping (${cellLabel(cell)})`, async ({ page }) => {
        await openCell(page, route, cell);
        const report = await measureLayout(page);

        expect(
          report.overflow,
          `${route} scrolls horizontally by ${report.overflow}px at ${VIEWPORT.width}px wide`,
        ).toBeLessThanOrEqual(1);

        expect(
          report.clipped,
          `text is silently cut off: ${report.clipped
            .map((c) => `<${c.tag}> "${c.text}" by ${c.overflow}px [${c.cls}]`)
            .join(" | ")}`,
        ).toEqual([]);
      });
    }
  }
});
