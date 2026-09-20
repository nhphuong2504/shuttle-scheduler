import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { cellKey, cellLabel, MATRIX_CELLS, openCell, ROUTES, WCAG_TAGS } from "./fixtures/matrix";
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
 * The scan covers the full infrastructure matrix - every route in both themes and both
 * densities - for the reason recorded in `fixtures/matrix.ts`: each axis was a blind spot
 * in turn, and each was found by widening the sweep rather than by reading the code.
 *
 * Record a new baseline with:  A11Y_RECORD=1 npm run test:e2e
 */

// `package.json` declares `"type": "module"`, so Playwright loads this spec as ESM
// and `__dirname` does not exist. Vitest specs in this repo can use it because
// Vitest transpiles to CJS; these cannot.
const BASELINE_PATH = join(import.meta.dirname, "a11y-baseline.json");
const RECORD = process.env["A11Y_RECORD"] === "1";

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
  for (const cell of MATRIX_CELLS) {
    for (const route of ROUTES) {
      test(`${route} (${cellLabel(cell)}) introduces no new a11y violation`, async ({ page }) => {
        await openCell(page, route, cell);

        const surfaced = await scan(page);
        const rules = surfaced.map((violation) => violation.id).sort();

        const key = cellKey(route, cell);
        recorded[key] = { rules };

        if (RECORD) return;

        const baseline = readBaseline();
        const known = new Set(baseline[key]?.rules ?? []);
        const added = rules.filter((rule) => !known.has(rule));

        if (added.length) {
          console.log(
            `\n${key} — new axe violations: ${added.join(", ")}\n` +
              `present: ${rules.join(", ") || "none"}\n` +
              `baseline: ${[...known].sort().join(", ") || "none"}\n`,
          );
        }
        expect(added, `new accessibility violations on ${key}`).toEqual([]);
      });
    }
  }
});

test.describe("keyboard reachability", () => {
  // The smoke test stays deliberately minimal: it proves the harness can drive the
  // keyboard at all, and that Tab does not stall on `<body>`. The exhaustive sweep
  // across the matrix lives in `focus.spec.ts`, which owns focus visibility. Keeping
  // one cheap guard here means a broken harness fails fast rather than as dozens of
  // confusing failures in the bigger spec.
  for (const cell of MATRIX_CELLS) {
    test(`the desk is operable from the keyboard alone (${cellLabel(cell)})`, async ({ page }) => {
      await openCell(page, "/", cell);

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
  }
});

test.afterAll(() => {
  if (!RECORD) return;
  const merged = { ...readBaseline(), ...recorded };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(merged, null, 2)}\n`);
});
