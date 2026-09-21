import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";

/**
 * Density as an operator experiences it.
 *
 * The unit tests in `src/lib/design/density.test.ts` pin the precedence rule as pure
 * logic. This file pins the behaviour a person actually relies on: that the Desk's
 * Compact default does not consume a preference they set elsewhere. That regression
 * is invisible to the unit test if the *hook* writes the default - the pure function
 * stays correct while the stored value is still overwritten - so the two layers are
 * checking genuinely different things.
 *
 * Assertions on the attribute go through Playwright's web-first matchers rather than
 * a bare `page.evaluate`. The attribute is written from an effect, so it lands one
 * tick after the click resolves; a non-retrying read races React and fails
 * intermittently for reasons that have nothing to do with the code under test.
 */

const DESK = "/";
const OTHER = "/registration";

/** Asserts the density actually in effect, retrying until the effect has run. */
function expectDensity(page: Page, value: "comfortable" | "compact") {
  return expect(page.locator("html")).toHaveAttribute("data-density", value);
}

/** A real computed font-size, to prove the tokens follow the attribute. */
function tierSize(page: Page, tier: "t1" | "t2" | "t3" | "t4") {
  return page.evaluate((t) => {
    const el = document.querySelector(`.text-${t}`);
    return el ? parseFloat(getComputedStyle(el).fontSize) : null;
  }, tier);
}

/** Starts from a known state: no stored preference, on the given route. */
async function freshAt(page: Page, route: string) {
  await page.goto(route);
  await page.evaluate(() => localStorage.clear());
  await page.goto(route);
  await hydrated(page);
}

/**
 * Waits until React has attached its handlers.
 *
 * Necessary because the density attribute is correct *before* hydration, by design,
 * so a plain visibility or attribute check says nothing about interactivity. Without
 * this the click below can land on an unwired button and the test fails for a reason
 * unrelated to density.
 */
function hydrated(page: Page) {
  return expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
}

test.describe("density defaults", () => {
  test("the Desk is Compact when nothing has been chosen", async ({ page }) => {
    await freshAt(page, DESK);
    await expectDensity(page, "compact");
  });

  test("a non-Desk route is Comfortable when nothing has been chosen", async ({ page }) => {
    await freshAt(page, OTHER);
    await expectDensity(page, "comfortable");
  });

  test("a route default is not written to storage", async ({ page }) => {
    // The heart of the design: visiting the Desk must not record a preference,
    // otherwise navigating away would leave the operator stuck in Compact.
    await freshAt(page, DESK);
    await expectDensity(page, "compact");
    expect(await page.evaluate(() => localStorage.getItem("tournova.density"))).toBeNull();
  });

  test("applies the density before first paint, so there is no reflow", async ({ page }) => {
    // The inline bootstrap script is what prevents a visible jump from 44px rows to
    // 32px on every Desk load. If it regresses, the attribute would only appear once
    // the bundle runs, so read it before any app script has had a chance.
    await page.goto(DESK);
    await page.evaluate(() => localStorage.clear());
    await page.goto(DESK, { waitUntil: "commit" });
    await expectDensity(page, "compact");
  });
});

test.describe("an explicit choice outlives the route that inspired it", () => {
  test("choosing Comfortable on the Desk keeps it across routes and reloads", async ({ page }) => {
    await freshAt(page, DESK);
    await expectDensity(page, "compact");

    await page.getByRole("button", { name: "Comfortable", exact: true }).click();
    await expectDensity(page, "comfortable");

    // This is the assertion that fails if the Desk writes its default on mount.
    await page.goto(DESK);
    await expectDensity(page, "comfortable");

    await page.goto(OTHER);
    await expectDensity(page, "comfortable");

    await page.reload();
    await expectDensity(page, "comfortable");
  });

  test("choosing Compact on a non-Desk route keeps it on the Desk too", async ({ page }) => {
    // The same rule in the other direction, so the test cannot pass by accident of
    // one hardcoded direction.
    await freshAt(page, OTHER);
    await page.getByRole("button", { name: "Compact", exact: true }).click();
    await expectDensity(page, "compact");

    await page.goto(DESK);
    await expectDensity(page, "compact");
  });

  test("resetting returns to the route's own default", async ({ page }) => {
    await freshAt(page, DESK);
    await page.getByRole("button", { name: "Comfortable", exact: true }).click();
    await expectDensity(page, "comfortable");

    // "Default" is only offered once a choice exists.
    await page.getByRole("button", { name: "Default" }).click();
    await expectDensity(page, "compact");
    expect(await page.evaluate(() => localStorage.getItem("tournova.density"))).toBeNull();
  });

  test("offers no reset before a choice has been made", async ({ page }) => {
    await freshAt(page, DESK);
    await expect(page.getByRole("button", { name: "Default" })).toHaveCount(0);
  });
});

test.describe("the density switch is operable and truthful", () => {
  test("exposes the active density to assistive tech", async ({ page }) => {
    await freshAt(page, DESK);

    const group = page.getByRole("group", { name: "Text and row density" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("button", { name: "Compact", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(group.getByRole("button", { name: "Comfortable", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await group.getByRole("button", { name: "Comfortable", exact: true }).click();
    await expect(group.getByRole("button", { name: "Comfortable", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("is reachable and operable from the keyboard", async ({ page }) => {
    await freshAt(page, DESK);

    const comfortable = page.getByRole("button", { name: "Comfortable", exact: true });
    await comfortable.focus();
    await expect(comfortable).toBeFocused();
    await page.keyboard.press("Enter");
    await expectDensity(page, "comfortable");
  });

  test("changes real text size, not just the attribute", async ({ page }) => {
    // Guards the whole chain: attribute -> custom property -> Tailwind utility ->
    // computed style. A break anywhere in it leaves the attribute flipping while the
    // page does not actually change, which an attribute-only test would still pass.
    // T2 is the tier that separates the two densities (13px vs 14px); T4 is the floor
    // and is deliberately identical in both, so it would prove nothing here.
    await freshAt(page, DESK);
    await expectDensity(page, "compact");
    expect(await tierSize(page, "t2")).toBe(13);

    await page.getByRole("button", { name: "Comfortable", exact: true }).click();
    await expectDensity(page, "comfortable");
    expect(await tierSize(page, "t2")).toBe(14);
  });

  test("keeps the reference tier at the floor in both densities", async ({ page }) => {
    // T4 does not shrink in Compact by design - it is already at 12px, which is the
    // reason the old 10px/11px scale was replaced.
    await freshAt(page, DESK);
    await expectDensity(page, "compact");
    expect(await tierSize(page, "t4")).toBe(12);

    await page.getByRole("button", { name: "Comfortable", exact: true }).click();
    await expectDensity(page, "comfortable");
    expect(await tierSize(page, "t4")).toBe(12);
  });
});
