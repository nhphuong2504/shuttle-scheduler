import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import type { MockMyRegistrationRow } from "./fixtures/app-mock";
import { CATEGORY_MD } from "./fixtures/desk-mock";
import { MATRIX_CELLS, openCell, WCAG_TAGS } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";

/**
 * The surfaces that are not inside a tournament, as a person uses them.
 *
 * Explore, My Tournaments and the create flow are the first pages in the app that are *not*
 * about one tournament, and they are also the first that answer a question with a URL: a
 * search, a status filter and a wizard step all live in the address so they can be shared,
 * refreshed and returned to. That is the part no other spec can see - `access.spec.ts`
 * asserts what each role is offered on these pages, and this file asserts what the page
 * does when it is *used*.
 *
 * `/` joined them in S6. It is the one surface whose content depends on the *session*
 * rather than on an address, so it is covered here in both readings: Landing, in the
 * routing spec's bare-domain case and in the shared matrix, and Home below, which needs a
 * signed-in caller and so cannot be swept by the route matrix at all.
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

/**
 * The caller's own pending request, as `my_tournament_registration` returns it.
 *
 * One row per requested entry; this is a doubles entry, so the partner the requester named is
 * on it. The declined and approved cases vary this rather than restating it.
 */
const PENDING_REQUEST: MockMyRegistrationRow = {
  registration_id: "reg-mine",
  status: "pending",
  decided_at: null,
  decision_note: null,
  created_at: "2026-09-29T09:00:00Z",
  entry_id: "entry-mine",
  category_id: CATEGORY_MD,
  category_code: "MD",
  category_name: "Men's Doubles",
  entry_type: "pair",
  partner_name: "Rin",
  partner_email: "rin@example.test",
};

test.describe("Home, for a caller working in a tournament", () => {
  test.use({ appMock: { preset: "layout", role: "user" } });

  test("says what needs the caller, and shows each tournament once under its role", async ({
    page,
  }) => {
    await page.goto(routes.home, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Welcome back", level: 1 })).toBeVisible();

    const main = page.getByRole("main");
    // The fixture's tournament is under way and this session owns it, so it is a task - it is
    // live and the caller runs it - with the one action that clears it: the Desk.
    await expect(main.getByRole("heading", { name: "Needs your attention", level: 2 })).toBeVisible();
    await expect(main.getByRole("link", { name: "Open the Desk" }).first()).toHaveAttribute(
      "href",
      routes.desk,
    );
    await expect(main.getByText("You run this").first()).toBeVisible();

    /**
     * **Once as a card**, and that is the assertion rather than a detail of it.
     *
     * The task names the tournament too, but as a sentence ("... is live") and not as a card;
     * what must not happen is the same card drawn under two headings. The caller owns this
     * one, so it is under Running and nowhere else.
     */
    await expect(main.getByRole("heading", { name: TOURNAMENT_NAME, level: 3 })).toHaveCount(1);
    await expect(main.getByRole("heading", { name: "Running", level: 2 })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Helping", level: 2 })).toHaveCount(0);
  });

  test("offers the signed-in caller the ways to their own tournaments from the header", async ({
    page,
  }) => {
    await page.goto(routes.home, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const header = page.getByRole("banner");
    await expect(header.getByRole("link", { name: "Browse tournaments" })).toHaveAttribute(
      "href",
      routes.explore,
    );
    await expect(header.getByRole("link", { name: "My tournaments" })).toHaveAttribute(
      "href",
      "/me/tournaments",
    );
    await expect(header.getByRole("link", { name: "New tournament" })).toHaveAttribute(
      "href",
      "/tournaments/new",
    );
  });

  test("greets an account with no tournament with ways to begin, not an empty page", async ({
    page,
  }) => {
    // The state a brand-new account is in: nothing owned, nothing helped, so there is nothing
    // to resume and nothing waiting.
    await installAppMock(page, {
      preset: "layout",
      role: "user",
      access: { is_owner: false, is_editor: false, can_edit: false, can_manage_access: false },
    });
    await page.goto(routes.home, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Welcome to Tournova", level: 1 })).toBeVisible();
    await expect(main.getByRole("heading", { name: /find a tournament to play in/i })).toBeVisible();
    await expect(main.getByRole("heading", { name: /run your own tournament/i })).toBeVisible();
    await expect(main.getByRole("heading", { name: /help run someone else/i })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Needs your attention" })).toHaveCount(0);
  });

  test("introduces no accessibility violation", async ({ page }) => {
    // Home cannot be swept by the shared route matrix, because its content depends on a
    // session and the matrix runs signed out. So it is scanned here, against the same rule
    // set - and to zero rather than to a baseline: a surface added in this commit has no
    // pre-existing findings to grandfather in.
    for (const cell of MATRIX_CELLS) {
      await openCell(page, routes.home, cell);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(
        results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`),
        `axe on ${routes.home}`,
      ).toEqual([]);
    }
  });
});

test.describe("Explore", () => {
  test.use({ appMock: { preset: "layout", role: null } });

  test("shows what exists to anybody, and offers sign-in rather than create", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /explore tournaments/i, level: 1 })).toBeVisible();
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();

    // A card opens the tournament's read-only workspace rather than the participant page:
    // Browse is where somebody reads an event, and Entries is the first of the five sections
    // a reader without the edit right is offered.
    await expect(page.getByRole("link", { name: TOURNAMENT_NAME })).toHaveAttribute(
      "href",
      routes.entries,
    );

    // A visitor is offered the trip that changes what they can do, once, in the header bar; creating a tournament is
    // not offered because the database refuses it for an anonymous caller, and a link that
    // can only fail is worse than no link.
    const pageActions = page.getByRole("main");
    await expect(page.getByRole("banner").getByRole("button", { name: /sign in/i })).toBeVisible();
    await expect(pageActions.getByRole("link", { name: /sign in/i })).toHaveCount(0);
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

/**
 * Explore at scale: the filters beside the list, and the shapes a long list is drawn in.
 *
 * The fixture holds one tournament, so what these can show is that each group is drawn in its
 * own shape and that every filter reads from and writes to the address. Ordering many rows,
 * paging and the refusal of an unknown word are the database's and are asserted against the
 * real functions in `integration/explore.test.ts`.
 */
test.describe("Explore, an upcoming tournament", () => {
  test.use({ appMock: { preset: "layout", role: null, status: "upcoming" } });

  test("sits in a row under its month, with a way to the cards", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /^upcoming/i, level: 2 })).toBeVisible();
    // The month heading: a group of its own, one level under the section.
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(1);
    await expect(page.getByRole("link", { name: TOURNAMENT_NAME })).toHaveAttribute(
      "href",
      routes.entries,
    );
    await expect(page.getByRole("link", { name: "Details" })).toBeVisible();
    await expect(page.getByText(/showing 1 of 1 upcoming/i)).toBeVisible();

    await page.getByRole("button", { name: "Cards" }).click();
    await expect(page).toHaveURL(/view=cards/);
    await expect(page.getByRole("button", { name: "Cards" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: "View details" })).toBeVisible();

    // The default is not written down: two spellings of one layout are two addresses.
    await page.getByRole("button", { name: "Timeline" }).click();
    await expect(page).not.toHaveURL(/view=/);
  });
});

test.describe("Explore, a completed tournament", () => {
  test.use({ appMock: { preset: "layout", role: null, status: "completed" } });

  test("is a row of a table, read down the column", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /^completed/i, level: 2 })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Tournament" })).toBeVisible();
    await expect(page.getByRole("link", { name: "See results" })).toBeVisible();
    await expect(page.getByText(/showing 1 of 1 completed/i)).toBeVisible();
  });
});

test.describe("Explore, filtered", () => {
  test.use({ appMock: { preset: "layout", role: null } });

  test("writes each filter into the address, shows it as a chip, and clears it", async ({
    page,
  }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();

    // The fixture's tournament is under way, so no registration window is open on it.
    await page.getByRole("button", { name: "Registration open", exact: true }).click();
    await expect(page).toHaveURL(/reg=true/);
    await expect(page.getByRole("button", { name: "Registration open", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText(/no tournament matches that search/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove Registration open" })).toBeVisible();

    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();
    await expect(page).not.toHaveURL(/reg=/);
  });

  test("keeps a date window and an order in the address, and drops words it has no filter for", async ({
    page,
  }) => {
    await page.goto(`${routes.explore}?when=month&sort=name`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel("When")).toHaveValue("month");
    await expect(page.getByLabel("Sort by")).toHaveValue("name");

    // A hand-edited address can name anything; an unknown word is dropped, not forwarded.
    await page.goto(`${routes.explore}?when=decade&sort=random&view=table`, {
      waitUntil: "load",
    });
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(TOURNAMENT_NAME)).toBeVisible();
    await expect(page.getByLabel("When")).toHaveValue("");
    await expect(page.getByLabel("Sort by")).toHaveValue("soonest");
    await expect(page).not.toHaveURL(/when=|sort=|view=/);
  });
});

/**
 * Registering, which needs a session the visitor does not have.
 *
 * The fixture answers `tournament_registration_state` with "not offered" everywhere else, so
 * the Register control is drawn in these two cases only - which is why the gate can be swept
 * without disturbing the specs above.
 */
test.describe("Explore, with the window open", () => {
  test.use({ appMock: { preset: "layout", role: null, registrationState: "open" } });

  test("sends a visitor to sign in, carrying the form to come back to", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // Registering needs a session, so the control says so rather than offering a form the
    // caller cannot submit. The wording is the participant page's own, so the two surfaces
    // name one trip the same way.
    const register = page.getByRole("link", { name: /sign in to register/i });
    await expect(register).toBeVisible();

    // The errand travels in the address: the return address is the participant page, which
    // is where the form is, and the intent is what lets the sign-in page say why.
    const href = (await register.getAttribute("href")) ?? "";
    expect(href.startsWith("/auth?")).toBe(true);
    expect(href).toContain(`redirect=${encodeURIComponent(routes.tournament)}`);
    expect(href).toContain("intent=register");

    await register.click();
    await page.waitForLoadState("networkidle");

    // The message, which is the difference between "sign in" and "sign in to continue":
    // somebody who clicked Register has a reason to fill the form, and the page says what
    // happens *next*. The heading already told them to sign in, so repeating that would be
    // the page telling them what they are looking at; naming the destination is the new fact.
    await expect(page.getByText(/go straight to that tournament's registration form/i)).toBeVisible();
    await expect(page).toHaveURL(/intent=register/);

    // And not the generic sentence, which is what a page with no errand says.
    await expect(page.getByText(/go back to the page you were on/i)).toHaveCount(0);
  });

  test("ignores an intent word it has no sentence for", async ({ page }) => {
    // A shared or hand-edited address can name anything, and this parameter selects copy the
    // page prints. An unrecognised word is dropped rather than rendered, so an address cannot
    // put somebody else's words on a page this app owns.
    await page.goto("/auth?redirect=%2Fexplore&intent=win", { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The return address still arrives, so the page keeps the sentence it owns - and nothing
    // is built from the value that did arrive.
    await expect(page.getByText(/go back to the page you were on/i)).toBeVisible();
    await expect(page.getByText(/registration form/i)).toHaveCount(0);
    // The word is gone from the address too, so the URL a person copies on is one the page
    // can read - the same rule the Explore status filter follows.
    await expect(page).not.toHaveURL(/intent=/);
  });
});

test.describe("Explore, signed in with the window open", () => {
  test.use({ appMock: { preset: "layout", role: "user", registrationState: "open" } });

  test("sends a member straight to the form", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // With a session there is nothing to ask for, so the control is the plain act and it goes
    // where the form is. Signing in is not on the path at all.
    await expect(page.getByRole("link", { name: /^register$/i })).toHaveAttribute(
      "href",
      routes.tournament,
    );
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
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
  });
});

test.describe("Creating a tournament, signed in", () => {
  test.use({ appMock: { preset: "layout", role: "user" } });

  // The create flow suggests a registration deadline from "now", and the tests below pick
  // dates in December. Left to the real clock they would fail the day the deadline suggestion
  // lands after the opening - a failure with no code change - so time starts here and runs.
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-07T19:03:00Z") });
  });

  test("runs the same four steps, with the step kept in the address", async ({ page }) => {
    await page.goto(routes.newTournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /new tournament/i, level: 1 })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
    await expect(page.getByText(/step 1 of 4/i).filter({ visible: true }).first()).toBeVisible();

    // Moving between steps writes the position into the address instead of holding it in
    // memory, so a refresh resumes where the host left off rather than starting again.
    // The step control's own label is "2 Events" - the number is part of the button - so the
    // query is the label alone.
    await page.getByRole("navigation", { name: "Setup steps" }).getByRole("button", { name: /events/i }).click();
    await expect(page).toHaveURL(/step=events/);

    await page.reload({ waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/step 2 of 4/i).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /choose the events/i })).toBeVisible();
  });

  /**
   * Nothing exists until the last step.
   *
   * A tournament is created complete or not at all, so moving through the steps must not
   * call the database, and what was typed must survive a reload - the answers live in the
   * browser's session storage until "Create tournament".
   */
  test("keeps what was typed across a reload, and creates nothing on the way", async ({ page }) => {
    const created: string[] = [];
    await page.route("**/rest/v1/rpc/create_tournament", async (route) => {
      created.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, contentType: "application/json", body: '"x"' });
    });

    await page.goto(routes.newTournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("City Open");
    await page.getByLabel("Tournament starts").fill("2026-12-01");
    await page.getByLabel("Tournament ends").fill("2026-12-03");
    await page.getByRole("button", { name: /^continue/i }).click();
    await expect(page).toHaveURL(/step=events/);

    await page.reload({ waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("navigation", { name: "Setup steps" })
      .getByRole("button", { name: /details/i })
      .click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("City Open");
    await expect(page.getByLabel("Tournament starts")).toHaveValue("2026-12-01");
    await expect(page.getByLabel("Tournament ends")).toHaveValue("2026-12-03");
    expect(created, "moving between steps must not create anything").toEqual([]);
  });

  test("tells a host what is missing only once they try to continue", async ({ page }) => {
    await page.goto(routes.newTournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#t-name-error")).toHaveCount(0);

    await page.getByRole("button", { name: /^continue/i }).click();
    await expect(page.locator("#t-name-error")).toHaveText("Give the tournament a name.");
    await expect(page.locator("#t-window-error")).toBeVisible();
    // It stayed on the step: there was nothing to carry forward.
    await expect(page.getByText(/step 1 of 4/i).filter({ visible: true }).first()).toBeVisible();
  });

  test("creates the tournament in one call, with the window and the registration in the venue's zone", async ({
    page,
  }) => {
    const calls: { payload: Record<string, unknown> }[] = [];
    await page.route("**/rest/v1/rpc/create_tournament", async (route) => {
      calls.push({ payload: JSON.parse(route.request().postData() ?? "{}") });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(routes.tournament.split("/").pop()),
      });
    });

    await page.goto(routes.newTournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("City Open");
    await page.getByLabel("Tournament starts").fill("2026-12-01");
    await page.getByLabel("Tournament ends").fill("2026-12-03");
    await page.getByRole("button", { name: /^continue/i }).click();

    await page.getByRole("button", { name: /^MS/ }).click();
    // The deadline defaults to the end of the day before the tournament, at the venue.
    await expect(page.getByLabel("Registration closes")).toHaveValue("2026-11-30T23:59");
    await page.getByRole("button", { name: /^continue/i }).click();
    await page.getByRole("button", { name: /^continue/i }).click();

    await expect(page.getByRole("heading", { name: /ready to create/i })).toBeVisible();
    await page.getByRole("button", { name: "Create tournament" }).click();
    await expect(page).toHaveURL(new RegExp(routes.tournament + "$"));

    expect(calls).toHaveLength(1);
    const payload = calls[0]?.payload.p_payload as Record<string, unknown>;
    expect(payload["name"]).toBe("City Open");
    expect(payload["starts_on"]).toBe("2026-12-01");
    expect(payload["ends_on"]).toBe("2026-12-03");
    expect(payload["venue_timezone"]).toBe("America/Chicago");
    expect((payload["categories"] as { code: string }[]).map((c) => c.code)).toEqual(["MS"]);
    // 23:59 in Chicago (UTC-6 in winter) is 05:59 UTC the next morning: the zone is the
    // venue's, not the browser's.
    expect(payload["registration_closes_at"]).toBe("2026-12-01T05:59:00.000Z");
    expect(payload["registration_opens_at"]).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    // The tournament has no playing days yet: those are chosen when the schedule is built.
    expect(payload).not.toHaveProperty("days");
  });

  test("blocks creating while a check fails, and says which step fixes it", async ({ page }) => {
    await page.goto(`${routes.newTournament}?step=review`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /things to fix before you can create it/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create tournament" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Go to Details" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Go to Events" }).first()).toBeVisible();
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
    await expect(page.getByRole("banner").getByText(TOURNAMENT_NAME)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Setup", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /new tournament/i })).toHaveCount(0);

    // Recalled by address rather than by clicking, which is what makes it a step and not a
    // scroll position.
    await expect(page.getByText(/step 3 of 4/i).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /competition format/i })).toBeVisible();

    // The way back is the caller's list, which is where the management acts live now.
    await expect(page.getByRole("main").getByRole("link", { name: /my tournaments/i })).toHaveAttribute(
      "href",
      routes.myTournaments,
    );
  });
});

test.describe("Setting up a tournament that has started", () => {
  test.use({ appMock: { preset: "layout", role: "admin", status: "in_progress" } });

  test("keeps what can still change editable, and says why the rest cannot", async ({ page }) => {
    await page.goto(routes.settings, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The steps are gone: a started tournament's events, caps and format are fixed, so
    // there is no rail to walk and no form that could only fail.
    await expect(page.getByRole("navigation", { name: "Setup steps" })).toHaveCount(0);
    await expect(page.getByText(/events, entry caps and format are fixed/i)).toBeVisible();

    // The first date and the timezone are locked, each with its reason; the last date, the
    // name and the venue are not.
    await expect(page.getByLabel("Tournament starts")).toBeDisabled();
    await expect(page.getByText(/first day can no longer move/i)).toBeVisible();
    await expect(page.locator("#t-tz")).toBeDisabled();
    await expect(page.getByLabel("Tournament ends")).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save details" })).toBeEnabled();

    // And the end of it: completing, which is the host's own act.
    await expect(page.getByRole("button", { name: "Complete tournament" })).toBeVisible();
    await expect(page.getByRole("button", { name: /start tournament/i })).toHaveCount(0);
  });
});

test.describe("A tournament with no playing days yet", () => {
  test.use({ appMock: { preset: "layout", role: "admin", status: "upcoming" } });

  test("asks which days are played, from the window's own dates", async ({ page }) => {
    // A tournament is created complete and has no playing days: they are chosen here.
    await page.route("**/rest/v1/tournament_days*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    const added: unknown[] = [];
    await page.route("**/rest/v1/rpc/add_tournament_day", async (route) => {
      added.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({ status: 200, contentType: "application/json", body: '"day-1"' });
    });

    await page.goto(routes.schedule, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The ordinary starting state, not a dead end that sends the host back to setup.
    await expect(page.getByRole("heading", { name: "Which days do you play?" })).toBeVisible();
    await expect(page.getByText(/need not be consecutive/i)).toBeVisible();
    await expect(page.getByText(/set up a tournament first/i)).toHaveCount(0);

    // Only the tournament window's own dates are offered, and none is chosen yet.
    const days = page.getByRole("group").getByRole("button");
    await expect(days).toHaveCount(1);
    await expect(days.first()).toHaveAttribute("aria-pressed", "false");

    await days.first().click();
    await expect.poll(() => added.length).toBe(1);
    expect(added[0]).toMatchObject({ p_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  test("cannot build a schedule until a day is chosen", async ({ page }) => {
    await page.route("**/rest/v1/tournament_days*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.goto(routes.schedule, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /build schedule|update schedule/i })).toHaveCount(0);
  });
});

test.describe("Setting up a completed tournament", () => {
  test.use({ appMock: { preset: "layout", role: "admin", status: "completed" } });

  test("is read-only all the way down", async ({ page }) => {
    await page.goto(routes.settings, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/is completed, so nothing here can change/i)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save details" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Complete tournament" })).toHaveCount(0);
  });
});

/**
 * The participant surface, with the window open.
 *
 * This cannot be reached by the shared matrix, and the reason is the fixture rather than the
 * route: the matrix's mock answers `tournament_registration_state` with nothing, which reads
 * as "not offered", so the route sweep meets a page whose Register panel says the tournament
 * takes no requests. Every reading that matters here - the form, the sign-in door, the
 * caller's own request - needs the window to be *open*, so it is served here.
 */
test.describe("The window is open", () => {
  test.use({ appMock: { preset: "layout", role: "user", registrationState: "open" } });

  test("draws the events the window opens, in the host's own order", async ({ page }) => {
    await page.goto(routes.tournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: TOURNAMENT_NAME, level: 1 })).toBeVisible();
    await expect(page.getByText("Registration is open.")).toBeVisible();

    // The events are pressed-button choices, and each carries its own facts inside the
    // control - the type, and capacity counted at approval (six approved entries here).
    await expect(page.getByRole("button", { name: /Men's Doubles/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Mixed Doubles/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Singles · 6 entries so far/ })).toHaveCount(2);

    // Nothing is chosen, so the request cannot be sent and the form says why.
    const send = page.getByRole("button", { name: "Send registration request" });
    await expect(send).toBeDisabled();
    await expect(page.getByText("Choose at least one event.")).toBeVisible();

    await page.getByRole("button", { name: /Men's Doubles/ }).click();
    await expect(send).toBeEnabled();
    await expect(page.getByText("1 event selected · up to 3 per player")).toBeVisible();
  });

  test("asks a visitor to sign in, carrying this page as the place to come back to", async ({
    page,
  }) => {
    // The signed-out reading of the same affordance. The sweep's `not_offered` fixture hides
    // it behind the window check, so this is the only place the door is asserted.
    await installAppMock(page, { preset: "layout", role: null, registrationState: "open" });
    await page.goto(routes.tournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const door = page.getByRole("link", { name: "Sign in to register" });
    await expect(door).toBeVisible();
    // A sign-in that dropped the reader on Home would be a longer way round to a page they
    // were already on, so the trip carries the address it started from.
    await expect(door).toHaveAttribute("href", /\/auth\?redirect=/);
    await expect(page.getByRole("button", { name: "Send registration request" })).toHaveCount(0);
  });
});

test.describe("The caller's own request, awaiting a decision", () => {
  test.use({
    appMock: {
      preset: "layout",
      role: "user",
      registrationState: "open",
      myRegistration: [PENDING_REQUEST],
    },
  });

  test("shows what was asked for, and lets the requester withdraw it", async ({ page }) => {
    await page.goto(routes.tournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Your registration" })).toBeVisible();
    await expect(page.getByText(/Men's Doubles with Rin/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw request" })).toBeVisible();

    // The form is seeded from the pending request, so the same form edits it rather than
    // filing a second one.
    await expect(page.getByRole("button", { name: "Update request" })).toBeVisible();
  });
});

test.describe("The caller's own request, declined", () => {
  test.use({
    appMock: {
      preset: "layout",
      role: "user",
      registrationState: "open",
      myRegistration: [
        {
          ...PENDING_REQUEST,
          status: "rejected",
          decided_at: "2026-09-29T10:00:00Z",
          decision_note: "Your partner has not registered yet.",
        },
      ],
    },
  });

  test("states the refusal as a fact, and lets the person ask again", async ({ page }) => {
    await page.goto(routes.tournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Not accepted", { exact: true })).toBeVisible();
    await expect(page.getByText("Your partner has not registered yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw request" })).toHaveCount(0);
    // A declined request is not a barrier: the form is back, as a fresh one.
    await expect(page.getByRole("button", { name: "Send registration request" })).toBeVisible();
  });
});

test.describe("The caller's own request, approved", () => {
  test.use({
    appMock: {
      preset: "layout",
      role: "user",
      registrationState: "open",
      myRegistration: [
        {
          ...PENDING_REQUEST,
          status: "approved",
          decided_at: "2026-09-29T10:00:00Z",
          entry_type: "individual",
          partner_name: null,
          partner_email: null,
        },
      ],
    },
  });

  test("says there is nothing left to ask for", async ({ page }) => {
    await page.goto(routes.tournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByText(/You are already registered for this tournament/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send registration request" })).toHaveCount(0);
  });
});

test.describe("The window is open, and nobody is signed in", () => {
  test.use({ appMock: { preset: "layout", role: null, registrationState: "open" } });

  test("asks a visitor to sign in, carrying this page as the place to come back to", async ({
    page,
  }) => {
    // The signed-out reading of the same affordance. The sweep's `not_offered` fixture hides
    // it behind the window check, so this is the only place the door is asserted.
    await page.goto(routes.tournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const door = page.getByRole("link", { name: "Sign in to register" });
    await expect(door).toBeVisible();
    // A sign-in that dropped the reader on Home would be a longer way round to a page they
    // were already on, so the trip carries the address it started from.
    await expect(door).toHaveAttribute("href", /\/auth\?redirect=/);
    // And it carries the errand, so the sign-in page can say that the caller comes back here
    // rather than leaving them to guess. Explore's Register control makes the same trip with
    // the same word, which is the one thing the two surfaces have to agree about.
    await expect(door).toHaveAttribute("href", /intent=register/);
    await expect(page.getByRole("button", { name: "Send registration request" })).toHaveCount(0);
  });
});

test.describe("The window is open, scanned", () => {
  test.use({ appMock: { preset: "layout", role: "user", registrationState: "open" } });

  test("introduces no accessibility violation", async ({ page }) => {
    await page.goto(routes.tournament, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations.map((v) => v.id).sort()).toEqual([]);
  });
});
