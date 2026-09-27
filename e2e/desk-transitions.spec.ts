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
const CELLS = "[data-transition-cell]";
const PANEL_TITLE = "Next transitions";

/** The panel element itself, addressed by its own heading rather than by position. */
function panel(page: Page) {
  return page.locator(PANEL).filter({ has: page.getByRole("heading", { name: PANEL_TITLE }) });
}

/**
 * Rows as the panel draws them, read once so every assertion reads one snapshot.
 *
 * Cells are read by their declared role rather than by index, because the panel is a table now
 * and a column's position is a layout decision that the design is deliberately willing to
 * change - the Transition and Due columns are already absent below `sm`. Asserting against
 * `cells.court` survives a column being added, dropped or reordered; asserting against
 * `cells[2]` would fail for a reason that has nothing to do with what is being tested.
 */
async function readRows(page: Page) {
  return page.locator(ROWS).evaluateAll((els) =>
    els.map((el) => {
      const cells: Record<string, string> = {};
      // The selector is inlined rather than closed over: `evaluateAll` serialises this function
      // and runs it in the page, where this module's scope does not exist.
      for (const node of Array.from(el.querySelectorAll("[data-transition-cell]"))) {
        const role = node.getAttribute("data-transition-cell");
        if (role) cells[role] = (node.textContent ?? "").trim();
      }
      return {
        text: (el.textContent ?? "").trim(),
        /** The interactive descendants a read-only row must not have. */
        controls: el.querySelectorAll("button, a, input, select, textarea").length,
        cells,
      };
    }),
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

      // Every row names a court, and the fixture's courts are numbered 1..8. This reads the
      // Court cell, so it is the court rather than any digit that happens to appear in a clock
      // time. It was a bare digit in a badge until the redesign, which reads as a rank rather
      // than as a court; the `C` is the part being asserted, so a row that reverted to a bare
      // number would fail here.
      for (const row of rows) {
        expect(row.cells.court, `row with no court label: ${row.text}`).toMatch(/^C[1-8]$/);
      }

      // Every row also carries the other four columns, which is what makes it a table rather
      // than four facts that happen to sit together. A cell that stopped rendering would leave
      // its column header over nothing.
      for (const row of rows) {
        expect(row.cells.match, `row with no match: ${row.text}`).toBeTruthy();
        expect(row.cells.kind, `row with no transition kind: ${row.text}`).toBeTruthy();
        expect(row.cells.due, `row with no due time: ${row.text}`).toBeTruthy();
        expect(row.cells.status, `row with no status: ${row.text}`).toBeTruthy();
      }

      // The fixture seeds one match live on court 2 with eight minutes of its slot left, and
      // three courts whose next match is due in twenty. So the order is the finish first, and
      // the derivation is being read rather than restated: this asserts the panel used the
      // fixture's own instants.
      expect(rows[0]?.cells.kind, `first row was not the soonest: ${rows[0]?.text}`).toMatch(
        new RegExp(COURT_TRANSITION_LABEL.finish, "i"),
      );
      expect(rows[0]?.cells.status).toMatch(/in 8 min/);

      // Nothing is late at the reference instant, so there is no aggregate to state and the
      // header must not imply one. The header is the panel's name and that one summary, and
      // nothing else - the column labels live in the table, not up here.
      await expect(panel(page).locator("header")).not.toContainText("overdue");
      await expect(panel(page).locator("header")).not.toContainText("Soonest first");
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

      // The estimate is marked as one in the panel's own words, not only by the tilde: the
      // kind reads "Expected finish", the Due cell carries a `~`, and a footnote says what
      // the `~` means. A projection presented as a fact is the thing requirement 4 forbids.
      const estimated = rows.filter((r) => r.cells.kind.includes(COURT_TRANSITION_LABEL.finish));
      expect(estimated.length, "no estimated finish to check").toBeGreaterThan(0);
      for (const row of estimated) {
        expect(row.cells.due, `an estimated finish with no qualifier: ${row.text}`).toMatch(/~\d/);
      }
      // The tilde is only honest if the panel says what it means.
      await expect(panel(page).getByText(/~ marks an estimate/)).toBeVisible();

      // And the scheduled start carries neither marker - not in its Due cell, and not in its
      // kind, which must not be named as an estimate either.
      const scheduled = rows.filter((r) => r.cells.kind.includes(COURT_TRANSITION_LABEL.start));
      expect(scheduled.length, "no scheduled start to check").toBeGreaterThan(0);
      for (const row of scheduled) {
        expect(row.cells.due, `a scheduled start marked as an estimate: ${row.text}`).not.toMatch(
          /~/,
        );
      }
    });

    test("the kind is carried by words, and the two kinds are different words", async ({
      page,
    }) => {
      await installAppMock(page, { preset: "states" });
      await openCell(page, "/", cell);

      /**
       * Colour and the icon used to be a second and third channel for the kind. Both were
       * removed at review - the panel was asked to shed its icons and all but one of its
       * filled chips - which leaves the words as the only channel that separates a projection
       * from a schedule. That is legitimate for information that is never a failure state, but
       * it is only legitimate if the two labels really are different words; this is what
       * asserts it in the rendered panel rather than in the vocabulary table.
       */
      const kinds = await page
        .locator(`${CELLS}[data-transition-cell="kind"]`)
        .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));

      expect(kinds.length, "no kind cells rendered").toBeGreaterThan(0);
      for (const kind of kinds) expect(kind, "a kind cell with no words").toBeTruthy();

      // Every rendered kind is one of the vocabulary's own labels, and both vocabulary labels
      // are actually on screen - a sweep that found only one would pass vacuously otherwise.
      const vocabulary = COURT_TRANSITION_KINDS.map((kind) => COURT_TRANSITION_LABEL[kind]);
      for (const kind of kinds) expect(vocabulary).toContain(kind);
      for (const label of vocabulary) expect(kinds, `no row rendered "${label}"`).toContain(label);
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
      // past zero, and none claims a negative or zero "in" interval. Read from the Status
      // cell, which is the only cell that carries a relative interval.
      for (const row of rows) {
        expect(
          row.cells.status,
          `a countdown on a transition that is already late: ${row.text}`,
        ).not.toMatch(/in \d+ min|in -|-?\d+ min late/);
        expect(row.cells.status).toMatch(/overdue/);
      }

      // An overrun is not a transition: the court that is already past its expected finish is
      // reported by its tile and by the Act-now alert, and not restated here as an estimate.
      expect(text, "an overrunning finish was restated as a transition").not.toMatch(
        new RegExp(COURT_TRANSITION_LABEL.finish, "i"),
      );

      // Several rows in the same late state are one fact repeated, so the panel states the
      // count once where the eye lands on entering it - and each row keeps its own figure,
      // which is the only place a per-court duration exists. The per-row warning chip is gone;
      // this header summary is the one place the repetition is collapsed.
      const late = rows.filter((row) => /overdue/.test(row.cells.status)).length;
      expect(late, "no late rows to aggregate").toBeGreaterThanOrEqual(2);
      await expect(panel(page).locator("header")).toContainText(`${late} overdue`);

      // Late rows are not drawn as a column of filled warning chips. The single count in the
      // header is the only filled warn surface the panel paints, which is what stops five
      // identical states reading as wallpaper.
      const warnSurfaces = await panel(page).evaluate((el) => {
        const warn = getComputedStyle(document.documentElement)
          .getPropertyValue("--warn-surface")
          .trim();
        const probe = document.createElement("span");
        probe.style.backgroundColor = warn;
        el.appendChild(probe);
        const resolved = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return Array.from(el.querySelectorAll("*")).filter(
          (node) => getComputedStyle(node).backgroundColor === resolved,
        ).length;
      });
      expect(warnSurfaces, "every late row painted its own warn chip").toBe(1);
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
      // The empty state must not carry a stale countdown into the panel's header either, and
      // the `~` footnote must go with the rows it explains rather than outliving them.
      await expect(panel(page).getByText(/~ marks an estimate/)).toHaveCount(0);
      // Nor should the table's own column headers survive a body with no rows in it.
      expect(
        await panel(page).locator("th").count(),
        "an empty panel still rendered column headers",
      ).toBe(0);
    });
  });
}
