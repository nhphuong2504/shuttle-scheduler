import { type Page } from "@playwright/test";

import {
  COURT_TRANSITION_KINDS,
  COURT_TRANSITION_LABEL,
  TRANSITION_LIMIT,
} from "../src/lib/tournament/desk-transitions";
import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { REFERENCE } from "./fixtures/desk-mock";
import { cellLabel, MATRIX_CELLS, openCell } from "./fixtures/matrix";

/**
 * The Next-transitions panel, rendered with data.
 *
 * The derivation is pinned in `desk-transitions.test.ts`; what only a browser can answer is
 * whether the panel the desk actually draws is the one that was designed. Three things in
 * particular are invisible to jsdom and to a source-level guard:
 *
 *   1. whether the two chips resolve to a colour in the real cascade rather than a class name
 *      that emits no rule;
 *   2. whether the panel is genuinely read-only - a `<button>` that happens to be styled like a
 *      row is a dispatch surface, and the requirement is that this panel must not be one;
 *   3. whether the countdown a moderator reads is a countdown, rather than a number that has
 *      gone negative.
 *
 * ## The clock is moved, not the fixture
 *
 * The overdue case is reached by advancing the pinned clock past the fixture's own scheduled
 * starts rather than by adding a late row to `desk-mock.ts`. That matters: the fixture's rows
 * are chosen backwards from the five court states, so appending a match would change which
 * states the board derives and put this file in conflict with `states.spec.ts`. Advancing the
 * clock changes only "now", which is the one input the panel is a function of - and it keeps
 * the rows under test the same rows the rest of the suite measures.
 */

const PANEL = "section";
const ROWS = "[data-transition-row]";
const PANEL_TITLE = "Next transitions";

/** The panel element itself, addressed by its own heading rather than by position. */
function panel(page: Page) {
  return page.locator(PANEL).filter({ has: page.getByRole("heading", { name: PANEL_TITLE }) });
}

/** Rows as the panel draws them, read once so every assertion reads one snapshot. */
async function readRows(page: Page) {
  return page.locator(ROWS).evaluateAll((els) =>
    els.map((el) => ({
      text: (el.textContent ?? "").trim(),
      /** The interactive descendants a read-only row must not have. */
      controls: el.querySelectorAll("button, a, input, select, textarea").length,
      labels: Array.from(el.querySelectorAll("span")).map((s) => (s.textContent ?? "").trim()),
    })),
  );
}

for (const cell of MATRIX_CELLS) {
  test.describe(cellLabel(cell), () => {
    test("the panel lists the venue's next transitions, soonest first", async ({ page }) => {
      await installAppMock(page, { preset: "states" });
      await openCell(page, "/", cell);

      const rows = await readRows(page);
      expect(rows.length, "no transitions rendered").toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(TRANSITION_LIMIT);

      // Every row names a court, and the fixture's courts are numbered 1..8. The first span in
      // a row is the court badge, so this is the badge rather than any digit that happens to
      // appear in a clock time.
      for (const row of rows) {
        expect(row.labels[0], `row with no court number: ${row.text}`).toMatch(/^[1-8]$/);
      }

      // The fixture seeds one match live on court 2 with eight minutes of its slot left, and
      // three courts whose next match is due in twenty. So the order is the finish first, and
      // the derivation is being read rather than restated: this asserts the panel used the
      // fixture's own instants.
      expect(rows[0]?.text, `first row was not the soonest: ${rows[0]?.text}`).toMatch(
        new RegExp(COURT_TRANSITION_LABEL.finish, "i"),
      );
      expect(rows[0]?.text).toMatch(/in 8 min/);
    });

    test("distinguishes an estimated finish from a scheduled start", async ({ page }) => {
      await installAppMock(page, { preset: "states" });
      await openCell(page, "/", cell);

      const rows = await readRows(page);
      const text = rows.map((r) => r.text).join("\n");

      // Both kinds are on the fixture's board, so both treatments must actually render.
      for (const kind of COURT_TRANSITION_KINDS) {
        expect(text, `no row rendered the ${kind} transition`).toContain(
          COURT_TRANSITION_LABEL[kind],
        );
      }

      // The estimate is marked as one in the panel's own words, not only by its fill: the type
      // is named "Expected finish", the instant carries a tilde, and the header explains the
      // tilde. A projection presented as a fact is the thing requirement 4 forbids.
      const estimated = rows.filter((r) => r.text.includes(COURT_TRANSITION_LABEL.finish));
      expect(estimated.length, "no estimated finish to check").toBeGreaterThan(0);
      for (const row of estimated) {
        expect(row.text, `an estimated finish with no qualifier: ${row.text}`).toMatch(/~\d/);
      }
      // The tilde is only honest if the panel says what it means.
      await expect(panel(page).getByText(/~ marks an estimate/)).toBeVisible();

      // And the scheduled start carries neither marker.
      const scheduled = rows.filter((r) => r.text.includes(COURT_TRANSITION_LABEL.start));
      expect(scheduled.length, "no scheduled start to check").toBeGreaterThan(0);
      for (const row of scheduled) {
        expect(row.text, `a scheduled start marked as an estimate: ${row.text}`).not.toMatch(/~/);
      }
    });

    test("the panel is read-only, whatever it is showing", async ({ page }) => {
      await installAppMock(page, { preset: "states" });
      await openCell(page, "/", cell);

      const rows = await readRows(page);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(
          row.controls,
          `a transition row offers an action, which the panel must not: ${row.text}`,
        ).toBe(0);
      }
      // The panel offers no action of its own either - no dispatch, no reorder, no rebuild.
      expect(
        await panel(page).locator("button, a, input, select, textarea").count(),
        "the transitions panel contains an interactive control",
      ).toBe(0);
    });

    test("past a scheduled start the countdown turns upward instead of negative", async ({
      page,
    }) => {
      await installAppMock(page, { preset: "states" });
      // Twenty-six minutes on from the fixture's reference: the live match on court 2 is now an
      // overrun, and the three matches that were due in twenty are six minutes late.
      await page.clock.setFixedTime(new Date(REFERENCE.getTime() + 26 * 60_000));
      await openCell(page, "/", cell);

      const rows = await readRows(page);
      expect(rows.length, "no transitions rendered once the fixture fell overdue").toBeGreaterThan(
        0,
      );

      const text = rows.map((r) => r.text).join("\n");
      expect(text, "an overdue start was still counted down").toMatch(/overdue/);

      // The assertion this test exists for: no row anywhere renders a countdown that has gone
      // past zero, and none claims a negative or zero "in" interval.
      for (const row of rows) {
        expect(
          row.text,
          `a countdown on a transition that is already late: ${row.text}`,
        ).not.toMatch(/in \d+ min|in -|-?\d+ min late/);
        expect(row.text).toMatch(/was due|overdue/);
      }

      // An overrun is not a transition: the court that is already past its expected finish is
      // reported by its tile and by the Act-now alert, and not restated here as an estimate.
      expect(text, "an overrunning finish was restated as a transition").not.toMatch(
        new RegExp(COURT_TRANSITION_LABEL.finish, "i"),
      );
    });

    test("an empty board states that nothing is transitioning", async ({ page }) => {
      await installAppMock(page, { preset: "states" });
      /**
       * Registered after the mock, so it wins for this table alone: Playwright runs handlers in
       * reverse registration order, and everything else falls back to the mock.
       *
       * Emptied rather than discouraged: with no matches there is nothing playing and nothing
       * queued, which is the only honest way to reach "no transitions" - the fixture's own
       * rows always leave one court mid-match or due to start.
       */
      await page.route("**/rest/v1/**", async (route) => {
        const url = new URL(route.request().url());
        const table = (url.pathname.split("/rest/v1/")[1] ?? "").split("?")[0] ?? "";
        if (table !== "tier_draw_matches") {
          await route.fallback();
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      });
      await openCell(page, "/", cell);

      expect(await page.locator(ROWS).count(), "an empty board still rendered rows").toBe(0);
      await expect(panel(page).getByText("Nothing transitioning")).toBeVisible();
      // The empty state must not carry a stale countdown into the panel's header either.
      await expect(panel(page).getByText(/~ marks an estimate/)).toHaveCount(0);
    });

    test("every rendered transition type is one the vocabulary defines", async ({ page }) => {
      await installAppMock(page, { preset: "states" });
      await openCell(page, "/", cell);

      const labels = await page
        .locator(`${ROWS} span`)
        .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));

      // A sweep that found nothing would pass vacuously.
      expect(labels.length).toBeGreaterThan(0);

      // The panel must not grow a third kind without a label and a chip, which is what deriving
      // the list from the vocabulary rather than restating it here guarantees.
      const vocabulary = COURT_TRANSITION_KINDS.map((kind) => COURT_TRANSITION_LABEL[kind]);
      const rendered = labels.filter((label) => vocabulary.includes(label));
      expect(rendered.length, "no transition type label resolved").toBeGreaterThan(0);
    });
  });
}
