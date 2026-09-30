import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { routes } from "./fixtures/routes";

/**
 * The three surfaces S5 added, as a person uses them.
 *
 * Explore, My Tournaments and the create flow are the first pages in the app that are *not*
 * about one tournament, and they are also the first that answer a question with a URL: a
 * search, a status filter and a wizard step all live in the address so they can be shared,
 * refreshed and returned to. That is the part no other spec can see - `access.spec.ts`
 * asserts what each role is offered on these pages, and this file asserts what the page
 * does when it is *used*.
 *
 * ## Why the filters are asserted through the address
 *
 * A filter that lives in React state passes every "does the list change" assertion and
 * still fails the reason it is in the URL at all: "here are the open tournaments" arrives
 * as a link, and a link that forgets the filter is a different page. So each filter case
 * asserts two things - that the list narrowed, and that the address says why - and the
 * status filter is additionally checked by *arriving* with it, which is the only way to
 * test the `validateSearch` parse rather than the write.
 */

const TOURNAMENT_NAME = "Layout Validation Invitational";
/** A term that appears only in the fixture's venue, not in its name. */
const VENUE_TERM = "Forker";
/** A term that appears only in one of the fixture's event names. */
const EVENT_TERM = "Mixed Doubles";

test.describe("Explore", () => {
  test.use({ appMock: { preset: "layout", role: null } });

  test("shows what exists to anybody, and offers sign-in rather than create", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /explore tournaments/i, level: 1 })).toBeVisible();
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();

    // A visitor is offered the trip that changes what they can do; creating a tournament is
    // not offered because the database refuses it for an anonymous caller, and a link that
    // can only fail is worse than no link.
    const pageActions = page.getByRole("main");
    await expect(pageActions.getByRole("link", { name: /sign in/i })).toBeVisible();
    await expect(pageActions.getByRole("link", { name: /new tournament/i })).toHaveCount(0);
  });
});

test.describe("Explore, searched", () => {
  test.use({ appMock: { preset: "layout", role: "user" } });

  test("matches the venue and the events, not just the name", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const search = page.getByRole("textbox", { name: "Search" });

    // The venue is the second thing a person remembers about a tournament, and the events
    // are the third. Both are matched by the database rather than by the browser, so this is
    // a claim about what the read was asked for.
    await search.fill(VENUE_TERM);
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();
    await expect(page).toHaveURL(/q=Forker/);

    await search.fill(EVENT_TERM);
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();

    // A term nothing matches is an empty state rather than a stale list, and it is the page's
    // own copy: the reader is told the search is why, and offered the way out.
    await search.fill("no-such-event");
    await expect(page.getByText(/no tournament matches that search/i)).toBeVisible();

    await page.getByRole("button", { name: /clear filters/i }).click();
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();
    // "No filter" has exactly one spelling, so clearing removes the term rather than storing
    // an empty one - two spellings would be two URLs for one page.
    await expect(page).not.toHaveURL(/q=/);
  });

  test("filters by lifecycle, and arrives at the filter through the address", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The fixture runs an in-progress tournament, so Upcoming is the word that must exclude
    // it. The pressed state is asserted too: the control tells the reader what they are
    // looking at, not merely what they could.
    await page.getByRole("button", { name: /^upcoming$/i }).click();
    await expect(page.getByText(/no tournament matches that search/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^upcoming$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page).toHaveURL(/status=upcoming/);

    // Arriving with the filter is the other half: this is `validateSearch` parsing, not the
    // click handler writing.
    await page.goto(`${routes.explore}?status=in_progress`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();

    // "Any status" is a member of the group rather than a cleared control, so it is the
    // option that widens the list back.
    await page.getByRole("button", { name: /any status/i }).click();
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();
  });

  test("ignores a status word it has no filter for", async ({ page }) => {
    // A shared or hand-edited address can name anything. An unrecognised word is dropped
    // rather than forwarded: the page must not send the database a request it would answer
    // with an exception, and it must not render an empty list that reads as "nothing is on".
    await page.goto(`${routes.explore}?status=draft`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();
    await expect(page.getByRole("button", { name: /any status/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // And the word is gone from the address rather than merely ignored, so the URL a person
    // copies on is one the page can read.
    await expect(page).not.toHaveURL(/status=/);
  });
});

test.describe("My tournaments", () => {
  test.use({ appMock: { preset: "layout", role: "user" } });

  test("separates what you own from what you were asked to help run", async ({ page }) => {
    await page.goto(routes.myTournaments, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // Ownership is the default view, because it is the one that always has something to say
    // to somebody who has just created a tournament.
    await expect(page.getByRole("button", { name: /owned by me/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const row = page.locator("li").filter({ hasText: TOURNAMENT_NAME }).first();
    await expect(row).toBeVisible();
    // The card's counts come from the summary read - entries are teams, events are categories
    // - and they are the same numbers on every surface that draws this card.
    await expect(row.getByText(/12 entries · 2 events/)).toBeVisible();
    // This caller's pointer names the fixture, so the row says so and offers no switch.
    await expect(row.getByText(/working here/i)).toBeVisible();
    await expect(row.getByRole("button", { name: /work in this one/i })).toHaveCount(0);

    // The other group is empty here, and says whose tournaments would appear in it.
    await page.getByRole("button", { name: /shared with me/i }).click();
    await expect(page.getByText(/nobody has shared one with you/i)).toBeVisible();
  });

  test("offers the switch to a caller whose pointer names something else", async ({ page }) => {
    // The pointer is the one thing this page does with a tournament that is not about
    // ownership: it says which one you are already in, and offers to move you.
    await installAppMock(page, { preset: "layout", role: "user", pointer: null });
    await page.goto(routes.myTournaments, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const row = page.locator("li").filter({ hasText: TOURNAMENT_NAME }).first();
    await expect(row.getByRole("button", { name: /work in this one/i })).toBeVisible();
    await expect(row.getByText(/working here/i)).toHaveCount(0);
  });

  test("names what deleting destroys before it does it", async ({ page }) => {
    await page.goto(routes.myTournaments, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const row = page.locator("li").filter({ hasText: TOURNAMENT_NAME }).first();
    const confirmation = new Promise<string>((resolve) => {
      page.once("dialog", (dialog) => {
        void dialog.dismiss();
        resolve(dialog.message());
      });
    });

    await row.getByRole("button", { name: /^delete$/i }).click();

    // §6.3: the confirmation names the tournament and the things it owns rather than asking
    // a bare yes/no, and it says the act cannot be undone. Dismissed rather than accepted,
    // because what is under test is the wording - the RPC's own guard is covered by the
    // integration suite.
    const message = await confirmation;
    expect(message).toContain(TOURNAMENT_NAME);
    expect(message).toMatch(/days, courts, events, players, entries, matches and results/);
    expect(message).toMatch(/cannot be undone/i);
  });

  test("is a sentence rather than a form for a signed-out caller", async ({ page }) => {
    await installAppMock(page, { preset: "layout", role: null });
    await page.goto(routes.myTournaments, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // There is nothing to show, because these are somebody's tournaments - so the page says
    // that, offers the sign-in that changes it, and points at what can be read without one.
    await expect(page.getByRole("heading", { name: /sign in first/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /explore what is on/i })).toBeVisible();
  });
});

test.describe("Creating a tournament", () => {
  test.use({ appMock: { preset: "layout", role: null } });

  test("asks for a session before it asks for anything else", async ({ page }) => {
    await page.goto(routes.newTournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The gate is page-level rather than a route guard, because the session lives in the
    // browser and this app server-renders first - so the check is on what is drawn.
    await expect(page.getByRole("heading", { name: /sign in first/i })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  });
});

test.describe("Creating a tournament, signed in", () => {
  test.use({ appMock: { preset: "layout", role: "user" } });

  test("runs the same four steps, with the step kept in the address", async ({ page }) => {
    await page.goto(routes.newTournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /new tournament/i, level: 1 })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
    await expect(page.getByText(/step 1 \/ 4/i)).toBeVisible();

    // Moving between steps writes the position into the address instead of holding it in
    // memory, so a refresh resumes where the host left off rather than starting again.
    // The step control's own label is "2 Events" - the number is part of the button - so the
    // query is the label alone.
    await page.getByRole("button", { name: /events/i }).click();
    await expect(page).toHaveURL(/step=events/);

    await page.reload({ waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/step 2 \/ 4/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /add an event/i })).toBeVisible();
  });
});

test.describe("Configuring one tournament", () => {
  test.use({ appMock: { preset: "layout", role: "user", status: "upcoming" } });

  test("is about the tournament the address names, and nothing else", async ({ page }) => {
    await page.goto(`${routes.settings}?step=structure`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The subject comes from the route, so the page can state it. Before S5 the same screen
    // was also the tournament *list* and the create flow, which meant the id in its address
    // was a host for a form rather than the thing the page was about.
    await expect(page.getByRole("heading", { name: TOURNAMENT_NAME, level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /new tournament/i })).toHaveCount(0);

    // Recalled by address rather than by clicking, which is what makes it a step and not a
    // scroll position.
    await expect(page.getByText(/step 3 \/ 4/i)).toBeVisible();

    // The way back is the caller's list, which is where the management acts live now.
    await expect(page.getByRole("link", { name: /all tournaments/i })).toHaveAttribute(
      "href",
      routes.myTournaments,
    );
  });
});
