import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ConsoleMessage } from "@playwright/test";

import { expect, test } from "./fixtures/app";

import { openCell, ROUTES } from "./fixtures/matrix";
import type { MatrixCell } from "./fixtures/matrix";
import {
  contrastPairs,
  lines,
  measureControls,
  measureLayout,
  MIN_MARGIN,
  runAxe,
  tabThrough,
} from "./fixtures/probes";
import { routes } from "./fixtures/routes";

/**
 * Everything measured on a route, taken from one load of it.
 *
 * Eight specs used to walk `ROUTES` separately - the axe baseline, contrast headroom, focus
 * visibility, layout, non-text contrast, focus-ring contrast, focus not obscured and
 * hydration - and each reopened every route, so one run paid for eight loads of each page
 * and two axe scans. They are the same measurements on the same page, so they are taken
 * together here; each keeps its own assertion and its own threshold, and a failure names the
 * check as well as the route. Reflow is the one that cannot share the load: it needs a
 * 320px viewport, so it is its own test per route below.
 *
 * What each check is for is recorded where its probe is defined (`fixtures/probes.ts`) and
 * in the criterion it measures; this file only decides the order and the assertions.
 *
 * Order matters. Everything that reads the page as loaded runs first; the Tab walk runs
 * last, because it moves focus and scroll position and would otherwise be measured into
 * the layout.
 *
 * The working viewport is 1366x768, the stated minimum device, so "does it fit" has a
 * meaningful answer.
 *
 * Record a new axe baseline with:  A11Y_RECORD=1 npm run test:e2e
 */
const VIEWPORT = { width: 1366, height: 768 };
const CELL: MatrixCell = {};

test.use({ viewport: VIEWPORT });

const BASELINE_PATH = join(import.meta.dirname, "a11y-baseline.json");
const RECORD = process.env["A11Y_RECORD"] === "1";

type Baseline = Record<string, { rules: string[] }>;

function readBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

const recorded: Baseline = {};

/**
 * Anti-vacuity floors. A sweep that measured nothing would pass, so each route must have
 * measured something. These replaced totals across the whole sweep (50 contrast pairs, 10
 * selected markers, 50 focus stops, 20 rings), which cannot be summed when routes run on
 * separate workers; the desk, which carries the section navigation, stands in for the
 * markers and rings that only some routes have.
 */
const MEASURES_MARKERS = new Set<string>([routes.desk]);

for (const route of ROUTES) {
  test(`${route} passes the route sweep`, async ({ page }) => {
    const mismatches: string[] = [];
    const record = (message: string) => {
      if (/hydrat/i.test(message)) mismatches.push(message.slice(0, 200));
    };
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() === "error") record(message.text());
    });
    page.on("pageerror", (error: Error) => record(error.message));

    await openCell(page, route, CELL);
    // The mismatch is raised during hydration, which `openCell` has already waited for. The
    // settle gives React's console output a chance to reach the listener.
    await page.waitForTimeout(250);

    expect.soft(mismatches, `hydration mismatches on ${route}`).toEqual([]);

    /* ---- axe: baseline, and contrast headroom from the same scan ---- */
    const results = await runAxe(page);
    const rules = results.violations.map((violation) => violation.id).sort();
    recorded[route] = { rules };
    if (!RECORD) {
      const known = new Set(readBaseline()[route]?.rules ?? []);
      const added = rules.filter((rule) => !known.has(rule));
      expect
        .soft(
          added,
          `new accessibility violations on ${route} (present: ${rules.join(", ") || "none"}; ` +
            `baseline: ${[...known].sort().join(", ") || "none"})`,
        )
        .toEqual([]);
    }

    const pairs = contrastPairs(results);
    expect.soft(pairs.length, `no contrast pairs measured on ${route}`).toBeGreaterThan(0);
    const tight = pairs.filter((pair) => pair.margin < MIN_MARGIN);
    expect
      .soft(
        tight,
        `pairs below their required ratio, or within ${MIN_MARGIN} of it, on ${route}: ` +
          tight.map((p) => `${p.ratio}:1 needing ${p.required}:1 ${p.where}`).join(" | "),
      )
      .toEqual([]);

    /* ---- 1.4.11 selected states and control edges ---- */
    const controls = await measureControls(page);
    const weak = [...controls.selected, ...controls.edged].filter((row) => row.ratio < 3);
    expect.soft(weak, `non-text contrast under 3:1 on ${route}\n  ${lines(weak)}`).toEqual([]);
    if (MEASURES_MARKERS.has(route)) {
      expect
        .soft(controls.selected.length, `no selected-state markers measured on ${route}`)
        .toBeGreaterThan(0);
    }

    /* ---- layout at the working viewport ---- */
    const layout = await measureLayout(page);
    expect
      .soft(layout.overflow, `${route} scrolls horizontally by ${layout.overflow}px at ${VIEWPORT.width}px`)
      .toBeLessThanOrEqual(1);
    expect
      .soft(
        layout.clipped,
        `text is silently cut off on ${route}: ${layout.clipped
          .map((c) => `<${c.tag}> "${c.text}" by ${c.overflow}px [${c.cls}]`)
          .join(" | ")}`,
      )
      .toEqual([]);

    /* ---- one Tab walk: visible, 3:1 ring, not obscured by the sticky header ---- */
    const stops = await tabThrough(page, 45);
    expect.soft(stops.length, `${route} exposed only ${stops.length} keyboard stop(s)`).toBeGreaterThan(2);

    const invisible = stops.filter((stop) => !stop.visible);
    expect
      .soft(
        invisible,
        `focus reached ${invisible.length} element(s) on ${route} with no visible indicator: ` +
          invisible.map((s) => `<${s.tag}> "${s.who}" [${s.cls}]`).join(" | "),
      )
      .toEqual([]);

    const ringed = stops.filter((stop) => stop.rings.length > 0);
    const dim = ringed
      .map((s) => ({ who: s.who, via: s.rings[0]!.via, ratio: s.rings[0]!.ratio }))
      .filter((r) => r.ratio < 3);
    expect.soft(dim, `focus indicators under 3:1 on ${route}\n  ${lines(dim)}`).toEqual([]);
    if (MEASURES_MARKERS.has(route)) {
      expect.soft(ringed.length, `no focus indicators measured on ${route}`).toBeGreaterThan(0);
    }

    const hidden = stops.filter((stop) => !stop.insideHeader && stop.swallowed).map((s) => s.who);
    expect
      .soft(hidden, `focused controls entirely hidden by the sticky header on ${route}`)
      .toEqual([]);

    console.log(
      `[sweep ${route}] ${pairs.length} pairs, ${controls.selected.length} selected, ` +
        `${controls.edged.length} edged, ${stops.length} stops, ${ringed.length} rings`,
    );
  });
}

/**
 * 1.4.10 reflow. 320 CSS pixels is the criterion's width: a 1280px viewport at 400% zoom.
 *
 * The assertion is about the *page*, not about every table. Content that legitimately needs
 * two dimensions - a wide match table, a draw bracket - is allowed to scroll inside its own
 * region, and this app wraps those in scroll containers. What may not happen is the document
 * itself scrolling sideways, which would put the header and the navigation off-screen.
 */
for (const route of ROUTES) {
  test(`${route} does not scroll the page sideways at 320px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openCell(page, route, CELL);
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const visible = doc.clientWidth;
      if (doc.scrollWidth <= visible + 1) return null;
      // Name what is sticking out, so a failure is actionable rather than a number.
      const culprits = [...document.querySelectorAll("*")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > visible + 1;
        })
        .slice(0, 3)
        .map((el) => {
          const cls =
            typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 3).join(".") : "";
          return `<${el.tagName.toLowerCase()}${cls ? "." + cls : ""}>`;
        });
      return { scrolled: doc.scrollWidth, visible, culprits };
    });
    expect(
      overflow,
      overflow
        ? `${route}: document is ${overflow.scrolled}px in a ${overflow.visible}px viewport; ` +
            `widest: ${overflow.culprits.join(", ")}`
        : "",
    ).toBeNull();
  });
}

test.afterAll(() => {
  if (!RECORD) return;
  const merged = { ...readBaseline(), ...recorded };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(merged, null, 2)}\n`);
});
