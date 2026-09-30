import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";
import { routes } from "./fixtures/routes";
import { settleAnimations } from "./fixtures/settle";

/**
 * The staff-only surfaces: the Court Dashboard, the Schedule settings panel, and the
 * score dialog.
 *
 * ## What this file is for, and what it deliberately is not
 *
 * It is NOT where the status and urgency matrix is validated. That matrix cannot be
 * reached by driving the app at all - a court is in exactly one state at a time, so
 * routing can only ever sample it. The matrix belongs to component rendering in jsdom,
 * where every permutation can be mounted at once.
 *
 * It IS where the properties a jsdom render cannot observe get checked: the real
 * cascade, real focus behaviour, and that a staff role actually flips the `disabled`
 * attribute rather than merely being read. Reconnaissance showed the role gates
 * *controls*, not pages, so "this control is enabled" is the real assertion - not "this
 * page is reachable", which is true signed out as well.
 *
 * ## Why there is no session file any more
 *
 * These tests used to skip unless `e2e/.auth/staff.json` existed, and that file had to be
 * recorded from a live backend before the gate could be closed. That made a green run
 * depend on a developer having credentials and remembering to record them, and a skipped
 * suite is indistinguishable from a passing one in a summary line.
 *
 * Now the session is synthetic and network-free: the shared mock in
 * `./fixtures/app-mock.ts` seeds the `localStorage` entry that `supabase.auth.getSession()`
 * reads and answers `current_system_role`, `current_tournament_id` and `tournament_access`.
 * Nothing is recorded, nothing is committed, and no credentials are needed here or in CI.
 *
 * `npm run test:e2e:record-auth` still exists for manual checks against a live backend.
 * It is not part of this file.
 *
 * ## Prerequisite versus expectation
 *
 * The two are different and the code says so explicitly:
 *
 *   - A **missing prerequisite** means the harness could not set up the situation - here,
 *     that the authenticated shell never rendered. Outside required mode this skips with
 *     a reason, because the alternative is a suite that cannot run at all without
 *     credentials. Under `E2E_REQUIRE_STAFF=1` it fails, so final validation cannot be
 *     satisfied by absence.
 *   - An **unmet expectation** is a control or dialog that is not there *when the session
 *     and the data are present*. That is always a hard failure, in both modes. Collapsing
 *     this into a skip is exactly how a suite reports green while never opening the score
 *     dialog once, which is the loophole this file used to have.
 */

const REQUIRED_STAFF = process.env["E2E_REQUIRE_STAFF"] === "1";

/** Every test in this file runs signed in as a tournament admin against fixture data. */
test.use({ appMock: { preset: "layout", role: "admin" } });

/**
 * Skips outside required mode, fails inside it. Only for a genuinely absent prerequisite.
 */
function requirePrerequisite(met: boolean, reason: string): void {
  if (met) return;
  if (REQUIRED_STAFF) {
    throw new Error(
      `${reason}\n\nE2E_REQUIRE_STAFF=1 is set, so a missing prerequisite is a failure. ` +
        `Staff surfaces have NOT been validated.`,
    );
  }
  test.skip(true, `Prerequisite missing: ${reason}`);
}

/**
 * Always fails. Use for anything that must be present given a valid session and data.
 */
function expectPresent(met: boolean, what: string): void {
  expect(
    met,
    `${what} is absent although the session and data are valid. This is an unmet ` +
      `expectation, not a missing prerequisite, so it is never skipped.`,
  ).toBe(true);
}

async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
}

const violationIds = (results: { violations: { id: string }[] }): string[] =>
  results.violations.map((v) => v.id).sort();

/** Navigates to the Desk and confirms the authenticated shell rendered. */
async function openStaffShell(page: Page): Promise<void> {
  await page.goto(routes.desk, { waitUntil: "load" });
  await page.waitForLoadState("networkidle");
  const signOut = await page.getByRole("button", { name: /sign out/i }).count();
  requirePrerequisite(signOut > 0, "The authenticated shell did not render");
}

test.describe("staff surfaces", () => {
  test("the session is a staff session", async ({ page }) => {
    await openStaffShell(page);

    // The role is rendered beside the email in the shell. If it is missing the session
    // is not a staff one, and every assertion below would be meaningless rather than
    // failing on its own.
    const account = await page.getByText(/@example\.test/).first().textContent();
    expect(account ?? "", "the account chip does not name a staff role").toContain("admin");
  });

  test("role-gated controls are enabled, not merely read", async ({ page }) => {
    await openStaffShell(page);
    await page.goto(routes.schedule, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    /**
     * The primary schedule action, matched without assuming which of its two labels
     * is showing. It reads "Build schedule" on a tournament that has never been
     * built and "Update schedule" once a schedule exists, so `layout` fixture data
     * - which already has times on it - lands on the second. Matching `/build/i`
     * alone silently made this assertion depend on the verb "rebuild".
     */
    const build = page.getByRole("button", { name: /build|update/i }).first();
    expectPresent(
      (await build.count()) > 0,
      "The Build control on /placement-schedule for an admin session",
    );
    // The page is just as reachable signed out. What changes is `disabled`, so
    // asserting on presence alone would pass either way and prove nothing.
    await expect(build).toBeEnabled();

    expect(violationIds(await scan(page))).toEqual([]);
  });

  test("the tournament settings panel opens by interaction and is accessible", async ({ page }) => {
    await openStaffShell(page);
    await page.goto(routes.schedule, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    /**
     * The panel is behind a toggle, so no route scan can see it - the same reason the
     * score dialog is opened rather than scanned in place. It is also the only surface
     * that holds the venue's court pool, the playing days and the match format, so
     * leaving it unscanned would leave the whole settings vocabulary unvalidated.
     */
    const toggle = page.getByRole("button", { name: /settings/i }).first();
    expectPresent(
      (await toggle.count()) > 0,
      "The settings toggle on /placement-schedule with an admin session",
    );
    await toggle.click();

    // The three sections are the redesigned surface: assert each is present rather than
    // trusting one heading to stand for the panel.
    for (const name of [/venue courts/i, /playing days/i, /match format/i]) {
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }

    // A day's breaks are edited in place, so adding one puts the break rows in front of
    // axe without any disclosure to open first.
    await page.getByRole("button", { name: /add break/i }).first().click();
    await settleAnimations(page, "main");

    expect(violationIds(await scan(page))).toEqual([]);
  });

  test("a replaced picker glyph is a real control that takes the focus ring", async ({ page }) => {
    await openStaffShell(page);
    await page.goto(routes.schedule, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /settings/i }).first().click();

    /**
     * The engines draw their own calendar and clock inside a date or time field. It takes
     * no token, no size and no focus ring, so `PickerInput` removes it and draws an icon
     * from the set - as a button, because the glyph it replaces was already a separate
     * click target and decoration would have removed the only way into the popup.
     *
     * That makes it a control, which is what needs proving: `e2e/criteria.spec.ts` walks
     * real focus order across the routes but this panel is behind a toggle, so without
     * this the ring on the replacement would be asserted nowhere.
     */
    const field = page.locator('input[type="date"]').first();
    expectPresent(
      (await field.count()) > 0,
      "A date field in the settings panel with an admin session",
    );
    // The class is what ties the field to the rule that removes the engine's glyph. It is
    // asserted here rather than measured, because the indicator is a user-agent
    // pseudo-element that `getComputedStyle` reports the default for either way.
    expect(await field.getAttribute("class")).toContain("picker-field");

    // Stepped forward from the field rather than asserted as the immediate next stop:
    // Chromium keeps a date field's month, day and year as segments in the tab order, so
    // the picker control is a few stops after the field rather than one. What is being
    // proved is that it is reachable in keyboard order from its own field, and that it
    // paints a ring when it is - not how many presses it takes.
    await field.focus();
    const walk: { name: string; tag: string; ring: boolean }[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          name: el.getAttribute("aria-label") ?? "",
          tag: el.tagName.toLowerCase(),
          // The shared ring is a box-shadow; the stylesheet also declares an outline
          // colour, so either counts as a visible indicator.
          ring:
            style.boxShadow !== "none" ||
            (style.outlineStyle !== "none" && style.outlineWidth !== "0px"),
        };
      });
      if (stop) walk.push(stop);
      if (stop && /open the (calendar|start time picker|end time picker)/i.test(stop.name)) break;
    }

    const reached = walk.find((stop) =>
      /open the (calendar|start time picker|end time picker)/i.test(stop.name),
    );
    expect(reached, "the picker control was not reachable by Tab from its own field").toBeDefined();
    expect(reached?.tag, "the picker affordance is not a real control").toBe("button");
    expect(reached?.ring, `no visible focus indicator on the picker control`).toBe(true);
  });

  /**
   * The value has to fit the box the field's padding reserves for it.
   *
   * A date or time value is laid out from its field's content-box left edge, so a field too
   * narrow for its value paints straight through the right padding and under the picker icon
   * - the padding does not stop it, and `pr-9` was in place throughout the whole of that
   * defect. The reservation is what the padding is actually for: the content box ends 4px
   * ahead of the icon's footprint, so a value that fits it cannot reach the glyph.
   *
   * Measured rather than asserted from the class list, because the painted width is the
   * engine's and moves with the font size, which is 16px below `md` and 14px above it. The
   * day windows were 7rem wide, which passed at 1366px and overlapped the icon by 8px at
   * 390px - so both widths are checked, and the narrower one is the one that bites.
   */
  const MEASURE_FIT = `
    (() => {
      const shown = (el) => {
        if (el.type === "time") {
          const [h, m] = (el.value || "00:00").split(":");
          const hour = Number(h);
          const suffix = hour < 12 ? "AM" : "PM";
          const twelve = hour % 12 === 0 ? 12 : hour % 12;
          return String(twelve).padStart(2, "0") + ":" + m + " " + suffix;
        }
        if (el.type === "date" && el.value) {
          // The display order is the locale's, not the value's, so it has to be reproduced
          // to measure what is actually painted.
          return new Intl.DateTimeFormat(undefined, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(el.value + "T00:00:00"));
        }
        return null;
      };

      return [...document.querySelectorAll('input[type="time"], input[type="date"]')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => {
          const style = getComputedStyle(el);
          const span = document.createElement("span");
          span.textContent = shown(el) || "";
          span.style.cssText = [
            "position:absolute",
            "left:-9999px",
            "top:0",
            "white-space:pre",
            "font-style:" + style.fontStyle,
            "font-weight:" + style.fontWeight,
            "font-size:" + style.fontSize,
            "font-family:" + style.fontFamily,
            "letter-spacing:" + style.letterSpacing,
            "font-variant-numeric:tabular-nums",
          ].join(";");
          document.body.append(span);
          const textWidth = span.getBoundingClientRect().width;
          span.remove();

          const contentWidth =
            el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);

          return {
            id: el.getAttribute("aria-label") || el.id,
            fontSize: style.fontSize,
            text: shown(el),
            contentWidth: Math.round(contentWidth),
            textWidth: Math.round(textWidth),
            slack: Math.round(contentWidth - textWidth),
          };
        });
    })()
  `;

  test("a picker's value fits the box its padding reserves, at both field widths", async ({
    page,
  }) => {
    await openStaffShell(page);
    await page.goto(routes.schedule, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole("button", { name: /settings/i }).first().click();
    await page.getByRole("button", { name: /add break/i }).first().click();

    const failures: string[] = [];

    for (const width of [1366, 390]) {
      // 390 is below `md`, so the fields paint at 16px there rather than 14px.
      await page.setViewportSize({ width, height: 900 });
      await settleAnimations(page, "main");
      await page.evaluate(() => document.fonts.ready);

      const fields = (await page.evaluate(MEASURE_FIT)) as {
        id: string;
        fontSize: string;
        text: string | null;
        contentWidth: number;
        textWidth: number;
        slack: number;
      }[];

      expectPresent(fields.length > 0, `A picker field to measure at ${width}px`);

      for (const field of fields) {
        if (field.slack < 0) {
          failures.push(
            `${width}px  ${field.id}  "${field.text}" at ${field.fontSize}: ` +
              `${field.textWidth}px of value in a ${field.contentWidth}px content box ` +
              `(${field.slack}px) - the value paints into the icon's reservation`,
          );
        }
      }
    }

    expect(failures, `picker values overrunning their fields\n  ${failures.join("\n  ")}`).toEqual(
      [],
    );
  });

  test("the score dialog opens by interaction and is accessible", async ({ page }) => {
    await openStaffShell(page);
    await page.goto(routes.scores, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    /**
     * The knockout rows are behind the second tab - the group tab holds pools and
     * placement rounds - so the tab has to be selected before any row exists to open.
     * The tab is also the thing being exercised: a row that is reachable only after a
     * real interaction is a different assertion from one that renders immediately.
     */
    await page.getByRole("tab", { name: /knockout/i }).click();

    /**
     * The dialog is mounted inside a closed Radix `Dialog`, so no route scan can see it.
     * Opening it is the only way to validate its contents, which is why "it did not open"
     * must be a failure rather than a skip.
     */
    const opener = page.getByRole("button", { name: /^open$/i }).first();
    expectPresent(
      (await opener.count()) > 0,
      "A match row with an Open control on /matches with fixture data present",
    );

    await opener.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The entrance animation has to finish before anything is measured. Scanning mid-fade
    // blends the dialog with the page behind it and reports contrast failures that are not
    // there once it is opaque.
    await settleAnimations(page, '[role="dialog"]');

    expect(violationIds(await scan(page))).toEqual([]);
  });

  test("focus is visible on an authenticated surface", async ({ page }) => {
    await openStaffShell(page);

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

  test("the authenticated desk announces the read-only banner is absent", async ({ page }) => {
    await openStaffShell(page);

    // The banner is the signed-out affordance. Its presence on a staff session would mean
    // the role was read but the session was not, which the two tests above cannot tell
    // apart on their own.
    await expect(page.getByText(/read-only view/i)).toHaveCount(0);
  });
});

/**
 * The two resets.
 *
 * Both are the app's only irreversible actions, so no route scan reaches either one
 * unexplored — the same reason the settings panel and the score dialog are opened here.
 * That matters more for these than for anything else on the page, because the wording is
 * load-bearing: §6.3 requires a destructive action to name what it destroys, and the pair
 * is only correct if each also says what the *other* keeps. A host who cannot tell them
 * apart loses a seed order they set by hand.
 *
 * The schedule reset still expands from behind its `Show` toggle. The placement one no
 * longer has a panel at all — it is a single `Reset` button in the header — so its wording
 * is asserted where it now lives: the confirmation dialog, captured rather than dismissed.
 *
 * Both themes, because the button paints the destructive fill and its 50% disabled state
 * on the header surface, which is exactly the pairing a contrast check is for.
 */
test.describe("the two resets", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(colorScheme, () => {
      test.use({ colorScheme });

      test("the schedule reset says the seed order survives", async ({ page }) => {
        await openStaffShell(page);
        await page.goto(routes.schedule, { waitUntil: "load" });
        await page.waitForLoadState("networkidle");

        const toggle = page.getByRole("button", { name: /^show$/i }).first();
        expectPresent((await toggle.count()) > 0, "The Reset toggle on /placement-schedule");
        await toggle.click();
        await settleAnimations(page, "main");

        // Names what it destroys, and what it keeps. The second half is the whole point of
        // this reset existing separately from the stage reset.
        await expect(
          page.getByText(/every reported result and every\s+scheduled time/i).first(),
        ).toBeVisible();
        await expect(
          page.getByText(/seed order\s+and any waivers are kept/i).first(),
        ).toBeVisible();

        expect(violationIds(await scan(page))).toEqual([]);
      });

      test("the placement reset refuses while the schedule depends on the seeding", async ({
        page,
      }) => {
        // The `layout` fixture serves a built tournament, so the gate is closed. This is
        // the state the gate exists for: a bracket is still paired from the seed order.
        await openStaffShell(page);
        await page.goto(routes.placement, { waitUntil: "load" });
        await page.waitForLoadState("networkidle");

        // It is a header button now, which is the whole point of the change — one action
        // rather than a panel with a toggle and a paragraph, and no longer sharing the row
        // with a Scores link. Scoped to the row that holds the `h1`, which is where the
        // page's actions live: `getByRole("banner")` is the app's nav, and this header sits
        // inside `main`, so it carries no `banner` role.
        const header = page
          .locator("main > div")
          .filter({ has: page.getByRole("heading", { name: "Placement", level: 1 }) })
          .first();
        // The Scores link that used to share this row is gone; the reset is now the page's
        // only header action, and results are still reached from the nav.
        await expect(header.getByRole("link", { name: /enter results in scores/i })).toHaveCount(0);
        const reset = header.getByRole("button", { name: /^reset$/i });
        expectPresent((await reset.count()) > 0, "The Reset button in the header of /placement");
        await expect(reset).toBeDisabled();

        // The refusal is still reachable without the panel: it is the button's accessible
        // description, so a screen reader is told why before the press rather than after.
        await expect(reset).toHaveAccessibleDescription(/still on the schedule/i);
        await expect(reset).toHaveAccessibleDescription(/Schedule tab first/i);
        // And the same string is on the wrapper, because a disabled button cannot show a
        // tooltip of its own — `Button` sets `disabled:pointer-events-none`.
        await expect(page.locator('span[title*="still on the schedule"]')).toHaveCount(1);

        expect(violationIds(await scan(page))).toEqual([]);
      });
    });
  }

  /**
   * The other side of the gate.
   *
   * `layout` can only ever prove the refusal, because it always serves a built schedule.
   * A regression that disabled the stage reset permanently — the button, the condition
   * inverted, the hook returning nothing — would pass every assertion above, so the
   * releasing state needs a fixture of its own. `prebuild` is the seeded field before
   * anything has been built, which is exactly when the order has nothing depending on it.
   */
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`${colorScheme} prebuild`, () => {
      test.use({ colorScheme, appMock: { preset: "prebuild", role: "admin" } });

      test("the placement reset is offered, and its confirmation names what it destroys", async ({
        page,
      }) => {
        await openStaffShell(page);
        await page.goto(routes.placement, { waitUntil: "load" });
        await page.waitForLoadState("networkidle");

        const header = page
          .locator("main > div")
          .filter({ has: page.getByRole("heading", { name: "Placement", level: 1 }) })
          .first();
        const reset = header.getByRole("button", { name: /^reset$/i });
        expectPresent((await reset.count()) > 0, "The Reset button in the header of /placement");
        await expect(reset).toBeEnabled();
        await expect(reset).not.toHaveAccessibleDescription(/still on the schedule/i);

        // The panel used to carry the wording. It lives on the confirmation now, so that is
        // where §6.3 is checked. The dialog is dismissed from inside the listener: nothing
        // else unblocks the page's own JS while a native confirm is open, so a `click()`
        // that waits for a handler registered afterwards would hang on the click itself.
        let dialogType = "";
        let dialogMessage = "";
        page.on("dialog", async (dialog) => {
          dialogType = dialog.type();
          dialogMessage = dialog.message();
          await dialog.dismiss();
        });

        await reset.click();
        expect(dialogType).toBe("confirm");
        expect(dialogMessage).toMatch(/clears the seed order and any waivers/i);
        // And it names the other reset, so the two remain distinguishable from one screen.
        expect(dialogMessage).toMatch(/Schedule tab's reset clears the matches/i);
        await settleAnimations(page, "main");

        // Dismissing is a refusal: nothing was undone.
        await expect(reset).toBeEnabled();

        expect(violationIds(await scan(page))).toEqual([]);
      });
    });
  }
});
