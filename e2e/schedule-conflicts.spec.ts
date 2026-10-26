import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";
import type { MockScheduleConflictRow } from "./fixtures/app-mock";
import { fixtureCourtId, fixtureMatchId } from "./fixtures/desk-mock";
import { routes } from "./fixtures/routes";
import { settleAnimations } from "./fixtures/settle";

/**
 * The schedule's conflicts, as the desk and the organiser's Schedule page show them.
 *
 * ## What this file is for
 *
 * `schedule_conflicts` is a read that is computed from the rows, so a conflict is not a
 * state anybody can click into - it is whatever the RPC says about the schedule as it
 * stands. That makes it exactly the kind of surface a hermetic spec should own: the fixture
 * supplies the RPC's answer and the assertions are about what the two audiences are then
 * shown, which is a claim no unit test can make about the real cascade and real focus order.
 *
 * It is also where the role boundary is pinned. The organiser gets a tournament-wide block
 * on the Schedule page; a moderator gets only the start confirmation, because a desk shows
 * every court of the day and is not scoped to one person. And a viewer - who has no business
 * reconstructing the running order from its conflicts - must make no request for it at all,
 * which is asserted by counting requests rather than by reading a flag.
 *
 * ## Why the presets differ between the describes
 *
 * The desk cases use `states`, because the *only* way to reach a Start button on a match
 * that also carries a conflict is a court whose next match is ready: in `layout` every
 * scheduled match belongs to players who are already on another court, so Start is a hard
 * physical conflict and never reaches the confirmation under test. The Schedule cases use
 * `layout`, which has both a running order and matches to name.
 */

/** One `schedule_conflicts` row, with the RPC's own `detail` kept deliberately unreadable. */
const conflict = (
  matchId: string,
  conflictKind: string,
  extra: Partial<MockScheduleConflictRow> = {},
): MockScheduleConflictRow => ({
  match_table: "tier_draw_matches",
  match_id: matchId,
  court_id: null,
  scheduled_time: null,
  ended_at: null,
  conflict_kind: conflictKind,
  /**
   * The RPC's detail carries shortened ids for debugging. The surfaces must never render it,
   * so it is a value no person would read - which is what the "not shown" assertion needs.
   */
  detail: "tier_draw_matches:3,4",
  ...extra,
});

const violationIds = (results: { violations: { id: string }[] }): string[] =>
  results.violations.map((v) => v.id).sort();

async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
}

test.describe("the organiser's conflict block", () => {
  test.use({ appMock: { preset: "layout", role: "admin" } });

  test("is absent when the schedule is clean", async ({ page }) => {
    await page.goto(routes.schedule, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await settleAnimations(page, "main");

    // The fixture answers `schedule_conflicts` with `[]` by default. Nothing about the
    // block - neither its headline nor a count - should be drawn.
    await expect(page.getByText(/schedule review/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /need schedule review/i })).toHaveCount(0);
  });

  test.describe("with conflicts", () => {
    test.use({
      appMock: {
        preset: "layout",
        role: "admin",
        scheduleConflicts: [
          conflict(fixtureMatchId(11), "court_overlap", {
            court_id: fixtureCourtId(7),
            scheduled_time: "2026-10-10T14:00:00.000Z",
            related_match_table: "tier_draw_matches",
            related_match_id: fixtureMatchId(12),
            minutes: 3,
          }),
          conflict(fixtureMatchId(12), "rest_shortfall", {
            court_id: fixtureCourtId(8),
            scheduled_time: "2026-10-10T15:00:00.000Z",
          }),
        ],
      },
    });

    test("counts the matches, says what is wrong with each, and points at Rebuild schedule", async ({
      page,
    }) => {
      await page.goto(routes.schedule, { waitUntil: "load" });
      await page.waitForLoadState("networkidle");
      await settleAnimations(page, "main");

      // Two matches, two kinds: the headline counts matches rather than rows.
      const headline = page.getByRole("button", { name: /2 matches need schedule review/i });
      await expect(headline).toBeVisible();
      await expect(headline).toHaveAttribute("aria-expanded", "false");

      const block = page
        .locator("section")
        .filter({ has: page.getByRole("button", { name: /need schedule review/i }) })
        .first();

      await headline.click();
      await expect(headline).toHaveAttribute("aria-expanded", "true");

      // One line per match, naming its court, with what is wrong beneath it: the other match and
      // the minutes when the RPC sends them, the kind's own label when it does not.
      await expect(block.getByText(/^Overlaps .+ on the same court by 3 min$/).first()).toBeVisible();
      await expect(block.getByText("A player won't have had full rest").first()).toBeVisible();
      await expect(block.getByText(/Court 7/).first()).toBeVisible();
      await expect(block.getByText(/Court 8/).first()).toBeVisible();

      // The RPC's `detail` is a debug string and is never part of what a person reads.
      await expect(block.getByText(/tier_draw_matches:3,4/)).toHaveCount(0);

      // The block names the one control that replans, and takes the reader to it rather
      // than offering a second button that would apply a plan on its own.
      await block.getByRole("button", { name: /go to rebuild schedule/i }).click();
      const focused = await page.evaluate(() => document.activeElement?.id ?? "");
      expect(focused, "the block should focus the existing Rebuild schedule control").toBe(
        "build-schedule",
      );

      expect(violationIds(await scan(page))).toEqual([]);
    });
  });

  test.describe("a viewer", () => {
    test.use({
      appMock: {
        preset: "layout",
        role: "user",
        access: { can_edit: false, is_owner: false, is_editor: false, can_manage_access: false },
      },
    });

    test("makes no conflict request and is shown no block", async ({ page }) => {
      const calls: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/rpc/schedule_conflicts")) calls.push(request.url());
      });

      await page.goto(routes.schedule, { waitUntil: "load" });
      await page.waitForLoadState("networkidle");
      await page.goto(routes.desk, { waitUntil: "load" });
      await page.waitForLoadState("networkidle");

      /**
       * Counted, not read from a flag. The RPC refuses a viewer, so a viewer asking for it
       * is a 403 the app would have to swallow; the point is that it is never asked.
       */
      expect(calls, "a viewer must not request schedule_conflicts").toEqual([]);
      await expect(page.getByText(/schedule review/i)).toHaveCount(0);
    });
  });
});

test.describe("the desk's start confirmation", () => {
  test.use({
    appMock: {
      preset: "states",
      role: "admin",
      scheduleConflicts: [
        conflict(fixtureMatchId(3), "court_overlap", { court_id: fixtureCourtId(3) }),
      ],
    },
  });

  test("asks before starting a conflicted match, and starts only on Start anyway", async ({
    page,
  }) => {
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /^Court 3:/ }).first().click();
    const operations = page.getByRole("dialog");
    await expect(operations).toBeVisible();

    // The start button opens the one shared confirmation dialog - there is no second modal.
    await operations.getByRole("button", { name: /start match/i }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await settleAnimations(page, '[role="alertdialog"]');
    await expect(confirm.getByText("Same court and time as another match").first()).toBeVisible();

    let starts = 0;
    page.on("request", (request) => {
      if (request.url().includes("/rpc/start_tier_draw_match")) starts += 1;
    });

    // Keeping waiting is a refusal: the dialog closes and no start is sent.
    await confirm.getByRole("button", { name: "Don't start" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(starts, "Don't start must not start the match").toBe(0);

    // Starting anyway is the acknowledgement, and it is the call the desk sends.
    await operations.getByRole("button", { name: /start match/i }).click();
    const confirmAgain = page.getByRole("alertdialog");
    await expect(confirmAgain).toBeVisible();
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/rpc/start_tier_draw_match")),
      confirmAgain.getByRole("button", { name: "Start anyway" }).click(),
    ]);
    expect(request.postDataJSON()).toMatchObject({ p_match_id: fixtureMatchId(3) });
  });

  test("introduces no accessibility violation with the dialog present", async ({ page }) => {
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await settleAnimations(page, "main");
    expect(violationIds(await scan(page))).toEqual([]);

    await page.getByRole("button", { name: /^Court 3:/ }).first().click();
    await settleAnimations(page, '[role="dialog"]');
    expect(violationIds(await scan(page))).toEqual([]);
  });
});
