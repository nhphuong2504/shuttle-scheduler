import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { MATRIX_CELLS, WCAG_TAGS, openCell } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";

/**
 * Entering a result, through the dialog that actually collects it.
 *
 * This is the desk's most consequential write and it had no browser test at all: the rules
 * were covered in `score-entry.test.ts` and `format.ts`, but nothing proved that the dialog
 * collects them, refuses what the server would refuse, or says why. A rule that is enforced
 * in a module nobody renders is not enforced.
 *
 * Court 2 of the `states` preset is live, so its box is editable and its rule is the
 * knockout best of three to 21. The two faults this file exists for are the quiet ones:
 * a blank row between games used to be filtered away and recorded as a legal 2-0, and a
 * rejected score used to leave a dead button with no explanation.
 */

async function openLiveMatch(page: Page): Promise<Locator> {
  await installAppMock(page, { preset: "states", role: "user" });
  await openCell(page, routes.desk, MATRIX_CELLS[0]!);
  await expect(page.getByRole("heading", { name: "Court board" })).toBeVisible();
  await page.getByRole("button", { name: "Court 2: playing", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** One box: `game` is 1-based, `side` is 0 for A and 1 for B. */
const box = (dialog: Locator, game: number, side: 0 | 1) =>
  dialog.locator(`input[aria-label^="Game ${game} "]`).nth(side);

const fillGame = async (dialog: Locator, game: number, a: string, b: string) => {
  await box(dialog, game, 0).fill(a);
  await box(dialog, game, 1).fill(b);
};

test.describe("Entering a result", () => {
  test("names the winner before the result is saved", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    const report = dialog.getByRole("button", { name: "Report result", exact: true });
    await expect(report).toBeDisabled();

    await fillGame(dialog, 1, "21", "19");
    await fillGame(dialog, 2, "21", "18");

    // Two games in a best of three, so the third row legitimately stays blank.
    await expect(dialog.getByText(/^.+ wins 2–0\.$/)).toBeVisible();
    await expect(report).toBeEnabled();
    await expect(dialog.getByRole("status")).toHaveCount(0);
  });

  test("refuses a score the rule will not accept, and says why", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    await fillGame(dialog, 1, "21", "20");

    const report = dialog.getByRole("button", { name: "Report result", exact: true });
    await expect(report).toBeDisabled();
    // The reason, in words the person at the desk can act on - not just a dead button.
    await expect(dialog.getByRole("status")).toHaveText(
      "Game 1 is not a winning score. Games are to 21, win by 2, capped at 30.",
    );
    // The box that is wrong is the box that is marked.
    await expect(box(dialog, 1, 0)).toHaveAttribute("aria-invalid", "true");
    await expect(box(dialog, 2, 0)).toHaveAttribute("aria-invalid", "false");
  });

  test("accepts 30-29 and refuses past the cap, which is where a deuce ends", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    const report = dialog.getByRole("button", { name: "Report result", exact: true });

    // 29-29 is deuce, so the next point takes the game at the cap.
    await fillGame(dialog, 1, "30", "29");
    await fillGame(dialog, 2, "21", "18");
    await expect(report).toBeEnabled();
    await expect(dialog.getByRole("status")).toHaveCount(0);

    // One point past it is not a game at all, and the reason names the cap.
    await box(dialog, 1, 0).fill("31");
    await expect(report).toBeDisabled();
    await expect(dialog.getByRole("status")).toHaveText(
      "Game 1 is past the cap. A game stops at 30.",
    );
  });

  test("refuses a blank game between two entered ones instead of collapsing it", async ({
    page,
  }) => {
    const dialog = await openLiveMatch(page);
    await fillGame(dialog, 1, "21", "19");
    await fillGame(dialog, 3, "21", "18");

    const report = dialog.getByRole("button", { name: "Report result", exact: true });
    // Filtering the blank row out would make this a legal 21-19, 21-18: a result nobody entered.
    await expect(report).toBeDisabled();
    await expect(dialog.getByRole("status")).toHaveText(
      "Game 2 is empty. Fill it in, or clear the games after it.",
    );
    await expect(dialog.getByText(/^.+ wins 2–1\.$/)).toHaveCount(0);
  });

  test("reads digits only, so a pasted score cannot become another number", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    // `Number("0x15")` is 21 and `Number("1e1")` is 10. Neither is what was typed.
    await box(dialog, 1, 0).fill("0x15");
    await expect(box(dialog, 1, 0)).toHaveValue("15");
    await box(dialog, 1, 1).fill("1e1");
    await expect(box(dialog, 1, 1)).toHaveValue("11");
  });

  test("records a legal result and closes", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    await fillGame(dialog, 1, "21", "19");
    await fillGame(dialog, 2, "21", "18");
    await dialog.getByRole("button", { name: "Report result", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  /**
   * A double tap on a large button is ordinary at a live desk, and two saves is two
   * corrections of the same result and two reflows of the day.
   *
   * `busy` alone cannot stop it: it is React state, so both clicks in one task read the value
   * from before the first. Firing both clicks synchronously is the only way to reproduce that
   * window deterministically - the guard that closes it has to be a ref.
   */
  test("a double click on Report result saves once", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    await fillGame(dialog, 1, "21", "19");
    await fillGame(dialog, 2, "21", "18");

    let saves = 0;
    page.on("request", (request) => {
      if (request.url().includes("/rpc/report_tier_draw_result")) saves += 1;
    });

    await dialog
      .getByRole("button", { name: "Report result", exact: true })
      .evaluate((el) => {
        (el as HTMLButtonElement).click();
        (el as HTMLButtonElement).click();
      });

    await expect(dialog).toHaveCount(0);
    // Waiting for the request the guard prevents: it would be issued within the first save's
    // round trip, so this is long enough to see it if it happened.
    await page.waitForTimeout(400);
    expect(saves).toBe(1);
  });

  test("a knockout result can say when it finished", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    await fillGame(dialog, 1, "21", "19");
    await fillGame(dialog, 2, "21", "18");

    // The field used to be drawn for placement alone, though `report_tier_draw_result` has
    // taken the offset since `20261011000000`. A late knockout result therefore reflowed the
    // day from the moment it was typed rather than from when the match ended.
    await dialog.getByRole("button", { name: "10 min ago", exact: true }).click();

    const sent = page.waitForRequest((request) =>
      request.url().includes("/rpc/report_tier_draw_result"),
    );
    await dialog.getByRole("button", { name: "Report result", exact: true }).click();

    const body = JSON.parse((await sent).postData() ?? "{}") as { p_ended_minutes_ago?: number };
    expect(body.p_ended_minutes_ago).toBe(10);
  });

  test("the refusal introduces no accessibility violation", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    await fillGame(dialog, 1, "21", "20");
    await expect(dialog.getByRole("status")).toBeVisible();
    await dialog
      .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    const results = await new AxeBuilder({ page })
      .withTags([...WCAG_TAGS])
      .include('[role="dialog"]')
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
