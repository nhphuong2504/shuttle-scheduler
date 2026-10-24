import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { MATRIX_CELLS, WCAG_TAGS, openCell } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";

/**
 * The Desk's Call next: the button on a court tile and the dialog it opens.
 *
 * In-app calling is available by default, without build-time feature flags.
 * Against the `states` preset: Court 3 is free with a ready match, Court 4's next match has a
 * player resting, Court 5's has a player on Court 2 right now, and Courts 6-8 are idle.
 */

const callButton = (page: Page, court: number) =>
  page.getByRole("button", { name: new RegExp(`^Call next, Court ${court}\\b`) });

async function openDesk(page: Page) {
  await installAppMock(page, { preset: "states", role: "user" });
  await openCell(page, routes.desk, MATRIX_CELLS[0]!);
  await expect(page.getByRole("heading", { name: "Court board" })).toBeVisible();
  expect(
    await page.getByRole("button", { name: /^Call next, Court/ }).count(),
    "Call next must be available by default for tournament operators",
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
    await expect(
      page.getByRole("button", { name: "Court 3: free ready", exact: true }),
    ).toBeVisible();
  });

  test("previews recipients before sending in Tournova", async ({ page }) => {
    await openDesk(page);
    const button = callButton(page, 3);
    await button.click();

    const dialog = page.getByRole("dialog", { name: "Notify the next match on Court 3" });
    await expect(dialog).toBeVisible();
    // The match dialog's own wording: comma-separated facts.
    await expect(dialog.getByText(/, scheduled \d{1,2}:\d{2}.*, Court 3 free now$/)).toBeVisible();
    // A doubles match: one row per player, all four free, since nobody here has played yet.
    await expect(dialog.getByRole("rowheader")).toHaveCount(4);
    await expect(dialog.getByRole("cell", { name: "Free" })).toHaveCount(4);
    await expect(dialog.getByLabel("Message")).toHaveValue(/Please come to the court now\.$/);

    await expect(dialog.getByText(/Sends to \d of 4 players/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("columnheader", { name: "Reach by" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test("sends the message and shares the last call time", async ({ page }) => {
    await openDesk(page);
    await callButton(page, 3).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Message").fill("Please prepare near Court 3.");
    const request = page.waitForRequest((r) => r.url().endsWith("/rpc/send_match_call"));
    await dialog.getByRole("button", { name: "Send", exact: true }).click();
    expect((await request).postDataJSON().p_message).toBe("Please prepare near Court 3.");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Notified .*Court 3/ })).toBeVisible();
  });

  test("shows a participant's inbox and acknowledges a call", async ({ page }) => {
    await openDesk(page);
    let read = false;
    await page.route("**/rest/v1/rpc/my_match_notifications", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "notice-one",
            read_at: read ? new Date().toISOString() : null,
            message: "Please prepare near Court 3.",
            created_at: "2026-10-24T14:00:00Z",
            tournament_id: "00000000-0000-4000-8000-000000000001",
            tournament_name: "Test tournament",
            court_number: 3,
            outdated: true,
          },
        ]),
      }),
    );
    await page.route("**/rest/v1/rpc/read_match_notification", (route) => {
      expect(route.request().postDataJSON().p_id).toBe("notice-one");
      read = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    });
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const inbox = page.getByRole("dialog", { name: "Notifications", exact: true });
    await expect(inbox.getByText("Please prepare near Court 3.")).toBeVisible();
    await expect(inbox.getByText(/This match has changed/)).toBeVisible();
    await inbox.getByRole("button", { name: "Mark as read" }).click();
    await expect(inbox.getByRole("button", { name: "Mark as read" })).toHaveCount(0);
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
    // The pair on Court 2 is one short line, and each row agrees.
    await expect(dialog.getByText(/ and .+ are on Court 2\.$/)).toHaveCount(1);
    await expect(dialog.getByText("On Court 2", { exact: true })).toHaveCount(2);
    // A Waiting court's match cannot start yet, so the players are asked to be ready, not to come.
    await expect(dialog.getByLabel("Message")).toHaveValue(/Please be ready near the court\.$/);
  });

  test("the open dialog introduces no a11y violation", async ({ page }) => {
    await openDesk(page);
    await callButton(page, 5).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Measured once the open animation has settled: mid-fade the surface is still blending into
    // the overlay, and axe read its muted text at 4.42:1 against a grey that never stays painted.
    await page
      .getByRole("dialog")
      .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    const results = await new AxeBuilder({ page })
      .withTags([...WCAG_TAGS])
      .include('[role="dialog"]')
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
