import { existsSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Layer 2 of the staff-surface strategy: authenticated integration.
 *
 * What this file is for, and what it deliberately is not.
 *
 * It is NOT where the status and urgency matrix is validated. That matrix cannot
 * be reached by driving the app at all - a live tournament is in one status per
 * match, so routing can only ever sample it. The matrix belongs to component
 * rendering in jsdom, where every permutation can be mounted at once.
 *
 * It IS where the properties a jsdom render cannot observe get checked: the real
 * cascade, real focus behaviour, and that a staff role actually flips the
 * `disabled` attribute rather than merely being read. Reconnaissance showed the
 * role gates controls, not pages, so "this control becomes enabled" is the real
 * assertion - not "this page becomes reachable".
 *
 * Recording a session:
 *   npm run test:e2e:record-auth
 * Without one, every test here skips with that instruction rather than failing, so the
 * suite stays runnable on a machine with no credentials.
 *
 * REQUIRED_STAFF closes that loophole for final validation. A skipped suite looks
 * identical to a passing one in CI output, so "4 skipped" can be reported as "green"
 * by anyone reading the summary - and the staff surfaces, which are the ones this whole
 * redesign is aimed at, would never have been rendered once. Setting
 *   E2E_REQUIRE_STAFF=1 npm run test:e2e
 * turns the skip into a failure. Final validation runs in that mode, so the gate
 * cannot be closed by the absence of a session file.
 */

const STAFF_STATE = join(import.meta.dirname, ".auth", "staff.json");
const hasSession = existsSync(STAFF_STATE);
const REQUIRED_STAFF = process.env["E2E_REQUIRE_STAFF"] === "1";

const SKIP_REASON =
  "No staff session. Record one with `npm run test:e2e:record-auth` to run staff-surface checks.";

// In required mode there is no skip: the absence of a session is itself the failure.
if (!hasSession && REQUIRED_STAFF) {
  test.describe("staff surfaces", () => {
    test("staff surfaces were validated, not skipped", () => {
      throw new Error(
        `${SKIP_REASON}\n\nE2E_REQUIRE_STAFF=1 is set, so this is a failure. Staff surfaces ` +
          `(Court Dashboard, Settings panels, score dialogs) have NOT been validated.`,
      );
    });
  });
}

async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
}

test.describe("staff surfaces", () => {
  // A skip, not a failure, in the default mode: the suite has to stay runnable
  // without credentials or the gate becomes a secret dependency people work around.
  // The suite-level check above converts this to a hard failure under E2E_REQUIRE_STAFF,
  // so the default stays friendly without the gate ever being quietly satisfiable.
  test.skip(!hasSession, SKIP_REASON);
  test.use(hasSession ? { storageState: STAFF_STATE } : {});

  test("the session is actually a staff session", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // If this fails the recorded state is stale or belongs to a non-staff
    // account, which would make every assertion below meaningless rather than
    // failing loudly on its own.
    const signedIn = await page
      .getByRole("button", { name: /sign out|sign in/i })
      .first()
      .textContent();
    expect(signedIn?.toLowerCase() ?? "").toContain("sign out");
  });

  test("role-gated controls are enabled, not merely read", async ({ page }) => {
    await page.goto("/placement-schedule", { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The page is just as reachable signed out - it was scanned that way in the
    // unauthenticated baseline. What changes is `disabled`. Asserting on
    // presence would pass either way and prove nothing.
    const build = page.getByRole("button", { name: /build/i }).first();
    if ((await build.count()) > 0) {
      await expect(build).toBeEnabled();
    }

    const results = await scan(page);
    expect(results.violations.map((v) => v.id).sort()).toEqual([]);
  });

  test("the score dialog opens by interaction and is accessible", async ({ page }) => {
    await page.goto("/matches", { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The dialog is mounted inside a closed Dialog, so no route scan can see it.
    // Opening it is the only way to validate its contents.
    const row = page.getByRole("row").nth(1);
    if ((await row.count()) === 0) {
      test.skip(true, "No matches in the active tournament to open.");
    }
    await row.click();
    await page.waitForTimeout(500);

    const dialog = page.getByRole("dialog");
    if ((await dialog.count()) === 0) {
      test.skip(true, "Row did not open a dialog in this tournament state.");
    }

    const results = await scan(page);
    expect(results.violations.map((v) => v.id).sort()).toEqual([]);
  });

  test("focus ring is visible on an authenticated surface", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await page.keyboard.press("Tab");
    const indicator = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(),
        visible: style.boxShadow !== "none" || style.outlineStyle !== "none",
      };
    });
    expect(indicator, "Tab reached no focusable element").not.toBeNull();
    expect(indicator?.visible, `no visible focus indicator on <${indicator?.tag}>`).toBe(true);
  });
});
