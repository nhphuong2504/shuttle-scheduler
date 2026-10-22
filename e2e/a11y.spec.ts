import { expect, test } from "./fixtures/app";

import { cellLabel, MATRIX_CELLS, openCell } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";

/**
 * Keyboard reachability, as a smoke test.
 *
 * The axe baseline (`a11y-baseline.json`) is checked per route in `route-sweep.spec.ts`,
 * which scans each route once and shares the scan with the contrast headroom check. Record
 * a new baseline with:  A11Y_RECORD=1 npm run test:e2e
 *
 * Axe is a floor, not a verdict: it cannot judge whether a focus order is logical or a
 * label understandable, and the manual checklist in the design plan covers the rest.
 */

test.describe("keyboard reachability", () => {
  // The smoke test stays deliberately minimal: it proves the harness can drive the
  // keyboard at all, and that Tab does not stall on `<body>`. The exhaustive sweep
  // across the matrix lives in `route-sweep.spec.ts`, which owns focus visibility. Keeping
  // one cheap guard here means a broken harness fails fast rather than as dozens of
  // confusing failures in the bigger spec.
  for (const cell of MATRIX_CELLS) {
    test(`the desk is operable from the keyboard alone (${cellLabel(cell)})`, async ({ page }) => {
      await openCell(page, routes.desk, cell);

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
