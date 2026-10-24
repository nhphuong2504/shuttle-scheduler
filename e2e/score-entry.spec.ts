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

/**
 * A real paste: the browser's own `paste` event, carrying text, on the box.
 *
 * `fill` is not a paste - it sets the value and fires `input` - so the paste path cannot be
 * reached through it. Returns whether the box took it: `dispatchEvent` answers false when the
 * handler called `preventDefault`, which is what "refused whole" means.
 *
 * A synthetic event has no default action, so an *accepted* paste inserts nothing; the test
 * asserts the box did not refuse it, not that the text appeared.
 */
async function paste(locator: Locator, text: string): Promise<boolean> {
  return locator.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    return el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

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

  test("takes digits only, two at most, however a score is entered", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    // `Number("0x15")` is 21 and `Number("1e1")` is 10; neither is what was typed, and the
    // box keeps only the digits rather than reading the string as a number.
    await box(dialog, 1, 0).click();
    await box(dialog, 1, 0).pressSequentially("2x1");
    await expect(box(dialog, 1, 0)).toHaveValue("21");

    // A third digit is a keystroke, not a score: no game needs one, and 319 is not 31.
    await box(dialog, 1, 1).click();
    await box(dialog, 1, 1).pressSequentially("319");
    await expect(box(dialog, 1, 1)).toHaveValue("31");
  });

  /**
   * A paste is a whole value at once, so filtering it rewrites it: "19-21" would become
   * "1921" and then be cut to "19" - a score nobody copied. The box refuses it whole instead,
   * keeps what it had, and says why.
   */
  test("refuses a pasted game rather than rewriting it, and says why", async ({ page }) => {
    const dialog = await openLiveMatch(page);
    await fillGame(dialog, 1, "21", "19");

    expect(await paste(box(dialog, 2, 0), "19-21")).toBe(false);
    await expect(box(dialog, 2, 0)).toHaveValue("");
    // The refusal it replaced ("a side needs 2 games") is about the result; this is about
    // the edit, and the edit is what just happened.
    await expect(dialog.getByRole("status")).toHaveText("Digits only, one score per box.");

    // Two digits is the ceiling: a whole game pasted into one box is refused, not halved.
    expect(await paste(box(dialog, 2, 0), "2119")).toBe(false);
    expect(await paste(box(dialog, 2, 0), "")).toBe(false);

    // A single score is what a box is for, and it is not refused.
    expect(await paste(box(dialog, 2, 0), "21")).toBe(true);
    await expect(dialog.getByRole("status")).not.toHaveText("Digits only, one score per box.");
  });

  /**
   * The clipboard is only half the question: the box may already hold a digit.
   *
   * `21` is a legal score and it still does not fit a box that reads `1`. Letting it through
   * would leave `maxLength` to keep `12` - a third score that was never copied, and exactly
   * the class of quiet rewrite the paste rule exists to stop. Selecting the digit is how the
   * moderator says "replace this one", and that paste is allowed.
   */
  test("refuses a paste that only fits the box once its own digits are gone", async ({ page }) => {
    const dialog = await openLiveMatch(page);

    await box(dialog, 1, 0).click();
    await box(dialog, 1, 0).pressSequentially("1");
    await expect(box(dialog, 1, 0)).toHaveValue("1");

    // Caret at the end, so all of "1" would stay and "21" would arrive after it.
    expect(await paste(box(dialog, 1, 0), "21")).toBe(false);
    await expect(box(dialog, 1, 0)).toHaveValue("1");
    await expect(dialog.getByRole("status")).toHaveText(
      "That would make three digits. Clear the box, or select a digit to replace.",
    );

    // Select the digit it replaces, and the same paste is welcome.
    //
    // `ControlOrMeta` rather than `Control`: on macOS `Control+a` is not select-all in a text
    // field, it moves the caret to the start - so the box kept its `1`, the paste was still
    // three digits, and this assertion failed on a developer's machine while passing in CI.
    // `ControlOrMeta` presses Cmd on darwin and Control elsewhere, which is the selection a
    // moderator actually makes.
    await box(dialog, 1, 0).press("ControlOrMeta+a");
    expect(await paste(box(dialog, 1, 0), "21")).toBe(true);
    await expect(dialog.getByRole("status")).not.toHaveText(
      "That would make three digits. Clear the box, or select a digit to replace.",
    );
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
    await dialog.getByRole("button", { name: "Change", exact: true }).click();
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

// Presentation-only fixtures: no pairing, scheduling or scoring RPC is called.
async function placementWordingFixture(page: Page, crossover = false, queuedCourtNumber = 6) {
  const { deskFixture } = await import("./fixtures/desk-mock");
  await installAppMock(page, { preset: "states", role: "user", access: { can_edit: false, is_owner: false, can_manage_access: false } });
  const fixture = deskFixture("states", "user");
  const entrants = (fixture.tables["placement_entrants"] as { id: string; category_id: string; tournament_id: string }[]).slice(0, crossover ? 6 : 3);
  const courts = fixture.tables["courts"] as { id: string; number: number }[];
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const base = { tournament_id: entrants[0]!.tournament_id, category_id: entrants[0]!.category_id,
    games: [], prerequisite_ids: [], started_at: null, ended_at: null, reported_time: null,
    winner_id: null, note: null, is_makeup: false, is_crossover: false, court_id: null, scheduled_time: null };
  const rows = [
    { ...base, id: "00000000-0000-4000-8000-000000009001", generation_key: "r1-1", stage: "round1", status: "reported", entrant_a_id: entrants[0]!.id, entrant_b_id: entrants[1]!.id, winner_id: entrants[0]!.id, games: [{ a: 21, b: 10 }], ended_at: past, reported_time: past },
    { ...base, id: "00000000-0000-4000-8000-000000009002", generation_key: crossover ? "r2-cross" : "r2-makeup-1", stage: "round2", status: "scheduled", entrant_a_id: crossover ? entrants[0]!.id : entrants[2]!.id, entrant_b_id: entrants[crossover ? 3 : 1]!.id, is_makeup: !crossover, is_crossover: crossover, court_id: courts.find(c => c.number === queuedCourtNumber)!.id, scheduled_time: new Date(Date.now() + 600_000).toISOString() },
  ];
  if (crossover) {
    for (const offset of [2, 4]) rows.splice(1, 0, {
      ...base, id: `00000000-0000-4000-8000-00000000900${offset + 1}`, generation_key: `r1-${offset + 1}`,
      stage: "round1", status: "reported", entrant_a_id: entrants[offset]!.id, entrant_b_id: entrants[offset + 1]!.id,
      winner_id: entrants[offset]!.id, games: [{ a: 21, b: 10 }], ended_at: past, reported_time: past,
    });
  }
  await page.route("**/rest/v1/placement_matches?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) }));
  await page.route("**/rest/v1/placement_entrants?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(entrants) }));
  const playing = queuedCourtNumber === 2
    ? (fixture.tables["tier_draw_matches"] as { court_id: string; status: string }[])
      .filter(m => m.court_id === courts.find(c => c.number === 2)!.id && m.status === "in-progress")
    : [];
  await page.route("**/rest/v1/tier_draw_matches?*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(playing) }));
}

test.describe("plain-language placement matches", () => {
  test("keeps a normal round label and explains an entrant's two matches in the detail", async ({ page }) => {
    await placementWordingFixture(page);
    await page.goto(routes.desk);
    await expect(page.getByText(/^Next \d{1,2}:\d{2}$/)).toBeVisible();
    await expect(page.locator("[data-match-identity]", { hasText: "MD R2" })).toBeVisible();
    await expect(page.getByText(/make-up|crossover/i)).toHaveCount(0);
    await page.getByRole("button", { name: /^Court 6:/ }).click();
    await expect(page.getByRole("dialog").getByText(/did not play in Round 1 and plays both placement matches in Round 2/)).toBeVisible();
    await expect(page.getByRole("dialog").getByText("MD R2", { exact: true })).toBeVisible();
    await page.getByRole("dialog").screenshot({ path: test.info().outputPath("placement-detail.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("dialog")).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("dialog").getByRole("button", { name: "Close", exact: true })).toBeVisible();
  });

  test("explains the official winner-versus-loser pairing without a technical type", async ({ page }) => {
    await placementWordingFixture(page, true);
    await page.goto(routes.desk);
    await expect(page.getByText(/^Next \d{1,2}:\d{2}$/)).toBeVisible();
    await expect(page.locator("[data-match-identity]", { hasText: "MD R2" })).toBeVisible();
    await page.getByRole("button", { name: /^Court 6:/ }).click();
    await expect(page.getByRole("dialog").getByText(/a Round 1 winner with a Round 1 loser/)).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/counts towards draw assignment/)).toBeVisible();
  });

  for (const crossover of [false, true]) {
    test(`preserves the busy court's current label and Next time/pairing line (${crossover ? "mixed results" : "held entrant"})`, async ({ page }) => {
      await placementWordingFixture(page, crossover, 2);
      await page.goto(routes.desk);
      const court = page.getByRole("button", { name: "Court 2: playing", exact: true });
      await expect(court.getByText("MD Draw A", { exact: true })).toBeVisible();
      await expect(court.getByText(/^Next \d{1,2}:\d{2}$/)).toBeVisible();
      await expect(court.getByText(/ vs /)).toHaveCount(2);
      await expect(court.getByText(/make-up|crossover|Placement ·|Ready now/)).toHaveCount(0);
    });
  }

  test("explains the held entrant in the Placement table alongside their own match progress", async ({ page }) => {
    await placementWordingFixture(page);
    await page.goto(routes.placement);
    const info = page.getByRole("button", { name: /^Why .+ plays both matches in Round 2$/ });
    await expect(info).toBeVisible();
    await expect(info.locator("xpath=ancestor::tr").getByRole("cell", { name: "0/2", exact: true })).toBeVisible();
    const explanation = page.getByText(/Plays both placement matches in Round 2\./);
    await expect(explanation).toHaveCount(0);
    await info.focus();
    await info.press("Enter");
    await expect(explanation).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(explanation).toHaveCount(0);
    await expect(info).toBeFocused();
  });
});
