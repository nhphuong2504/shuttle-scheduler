import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { MATRIX_CELLS, WCAG_TAGS, openCell } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";

/**
 * The Desk's Call next: the button on a court tile and the dialog it opens.
 *
 * The layout is built ahead of the sending feature and held behind
 * `VITE_FEATURE_NOTIFY_PLAYERS`, which `playwright.config.ts` turns on for the server it starts.
 * Against the `states` preset: Court 3 is free with a ready match, Court 4's next match has a
 * player resting, Court 5's has a player on Court 2 right now, and Courts 6-8 are idle.
 */

const callButton = (page: Page, court: number) =>
  page.getByRole("button", { name: new RegExp(`^Call next, Court ${court}\\b`) });

async function openDesk(page: Page) {
  await installAppMock(page, { preset: "states", role: "user" });
  await openCell(page, routes.desk, MATRIX_CELLS[0]!);
  await expect(page.getByRole("heading", { name: "Court board" })).toBeVisible();
  // Fails rather than skips: a skip is not a pass, and the usual cause is a dev server that was
  // already running without the flag, which `reuseExistingServer` then reuses.
  expect(
    await page.getByRole("button", { name: /^Call next, Court/ }).count(),
    "no Call next button: restart the dev server with VITE_FEATURE_NOTIFY_PLAYERS=1",
  ).toBeGreaterThan(0);
}

test.describe("Call next", () => {
  test("is offered for a queued match and not for an idle court", async ({ page }) => {
    await openDesk(page);
    await expect(callButton(page, 3)).toBeEnabled();
    for (const idle of [6, 7, 8]) {
      await expect(callButton(page, idle), `idle Court ${idle} offered a call`).toHaveCount(0);
    }
    // Two controls side by side: the tile still opens its match under its own name.
    await expect(page.getByRole("button", { name: "Court 3: free ready", exact: true })).toBeVisible();
  });

  test("opens a dialog that sends nothing and says so", async ({ page }) => {
    await openDesk(page);
    const button = callButton(page, 3);
    await button.click();

    const dialog = page.getByRole("dialog", { name: "Notify the next match on Court 3" });
    await expect(dialog).toBeVisible();
    // The match dialog's own wording: comma-separated facts.
    await expect(dialog.getByText(/, due \d{1,2}:\d{2}.*, Court 3 free now$/)).toBeVisible();
    // A doubles match: one row per player, all four free, since nobody here has played yet.
    await expect(dialog.getByRole("rowheader")).toHaveCount(4);
    await expect(dialog.getByRole("cell", { name: "Free" })).toHaveCount(4);
    await expect(dialog.getByLabel("Message")).toHaveValue(/Please come to the court now\.$/);

    // No contact details are connected yet, so nothing claims to send.
    await expect(dialog.getByText("Sending is not connected yet.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("columnheader", { name: "Reach by" })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test("names a resting player and when they are free", async ({ page }) => {
    await openDesk(page);
    await callButton(page, 4).click();
    const dialog = page.getByRole("dialog");
    // The pair that has just finished on this court rests together.
    await expect(dialog.getByText(/^Resting until \d{1,2}:\d{2}$/)).toHaveCount(2);
    await expect(dialog.getByRole("cell", { name: "Free" })).toHaveCount(2);
  });

  test("warns, without locking, when a player is on another court", async ({ page }) => {
    await openDesk(page);
    const button = callButton(page, 5);
    await expect(button).toHaveAccessibleName(/a player is on another court/);
    await expect(button).toBeEnabled();

    await button.click();
    const dialog = page.getByRole("dialog");
    // Both players of the pair on Court 2 are named, each once, and the rows agree.
    await expect(
      dialog.getByText(/is playing on Court 2 right now and will get this on court\./),
    ).toHaveCount(2);
    await expect(dialog.getByText("On Court 2", { exact: true })).toHaveCount(2);
  });

  test("the open dialog introduces no a11y violation", async ({ page }) => {
    await openDesk(page);
    await callButton(page, 5).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).include('[role="dialog"]').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
