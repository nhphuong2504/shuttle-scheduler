import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
/**
 * Rendered accessibility and keyboard reachability, as a regression gate.
 *
 * Axe is a floor, not a verdict. It reads the DOM and the computed cascade, so it
 * reliably catches missing names, bad roles, and contrast it can resolve - and it
 * cannot judge whether a focus order is logical, whether a label is
 * understandable, or whether the visual hierarchy communicates priority. This file
 * therefore asserts only what a machine can decide, and the manual checklist in
 * the design plan covers the rest. A green run here is evidence, not conformance.
 *
 * The gate is a pinned baseline rather than a zero-violation target, because the
 * app has pre-existing findings and this phase changes no visuals. A rule that is
 * already failing may keep failing until its phase fixes it; a rule that starts
 * failing when it was not failing before fails the suite immediately.
 *
 * Record a new baseline with:  A11Y_RECORD=1 npm run test:e2e
 */

// `package.json` declares `"type": "module"`, so Playwright loads this spec as ESM
// and `__dirname` does not exist. Vitest specs in this repo can use it because
// Vitest transpiles to CJS; these cannot.
const BASELINE_PATH = join(import.meta.dirname, "a11y-baseline.json");
const RECORD = process.env["A11Y_RECORD"] === "1";

/** Routes reachable without a staff session. Authenticated-only routes are added
 *  when phase 6 sweeps the status matrix against a seeded tournament. */
const ROUTES = [
  "/",
  "/registration",
  "/placement",
  "/draws",
  "/knockout",
  "/placement-schedule",
  "/matches",
  "/setup",
] as const;

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type Baseline = Record<string, { rules: string[] }>;

function readBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

async function scan(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? "unknown",
    nodes: violation.nodes.length,
  }));
}

const recorded: Baseline = {};

test.describe("rendered accessibility", () => {
  for (const route of ROUTES) {
    test(`${route} introduces no new a11y violation`, async ({ page }) => {
      const response = await page.goto(route, { waitUntil: "load" });
      // A redirect to sign-in is a legitimate response; a 5xx is not.
      expect(response?.status() ?? 0).toBeLessThan(500);
      await page.waitForLoadState("networkidle");

      const surfaced = await scan(page);
      const rules = surfaced.map((violation) => violation.id).sort();
      recorded[route] = { rules };

      if (RECORD) return;

      const baseline = readBaseline();
      const known = new Set(baseline[route]?.rules ?? []);
      const added = rules.filter((rule) => !known.has(rule));

      if (added.length) {
        console.log(
          `\n${route} — new axe violations: ${added.join(", ")}\n` +
            `present: ${rules.join(", ") || "none"}\n` +
            `baseline: ${[...known].sort().join(", ") || "none"}\n`,
        );
      }
      expect(added, `new accessibility violations on ${route}`).toEqual([]);
    });
  }
});

test.describe("keyboard reachability", () => {
  test("the desk is operable from the keyboard alone", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // Tab must reach a real control, not stall on the body. This proves the
    // harness can drive the keyboard; the full focus-order and focus-visibility
    // sweep belongs to phase 6, once the status matrix is stable.
    await page.keyboard.press("Tab");
    const reached = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        // A visible focus indicator is either a ring (box-shadow) or an outline.
        visible: style.boxShadow !== "none" || style.outlineStyle !== "none",
      };
    });

    expect(reached, "Tab reached no focusable element").not.toBeNull();
    expect(reached?.visible, `no visible focus indicator on <${reached?.tag}>`).toBe(true);
  });
});

test.afterAll(() => {
  if (!RECORD) return;
  const merged = { ...readBaseline(), ...recorded };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(merged, null, 2)}\n`);
});
