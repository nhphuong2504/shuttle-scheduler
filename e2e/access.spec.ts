import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { routes } from "./fixtures/routes";

/**
 * Access, as a person meets it.
 *
 * The role redesign split one staff-role ladder into two independent questions: a
 * platform role (`admin | user`) and a per-tournament right (owner, editor, or neither).
 * `staff-surfaces.spec.ts` proves the *admin* side of that - that an admin session
 * enables the controls it should - and the integration suite proves the RPC guards behind
 * it. What is left, and what this file covers, is the other half of the same claim: that
 * the four answers a signed-in person can actually get here are told apart on screen.
 *
 *   - an **owner** is offered the whole tournament, including the two ownership acts;
 *   - an **editor** is offered the operation but not the ownership;
 *   - a **viewer** - any signed-in user with no row anywhere - is offered neither, which
 *     is the state the fixture could not express until the access summary and the row
 *     store learned to agree;
 *   - a **signed-out visitor** still reads the tournament, because public read is first
 *     class rather than a consequence of signing in.
 *
 * ## What "no controls" means, precisely
 *
 * The ownership acts are *absent* for a viewer, and so is every control on the tournament's
 * own pages: the five read-only sections remove the operator's forms, planners and per-row
 * acts rather than disabling them, and a signed-out visitor meets the identical surface.
 * What this file pins is both halves - that a signed-in person with no row is not silently
 * treated as an owner, and that a reader is never shown a control they may not use.
 *
 * ## Why the label cases are separate describes
 *
 * `status` is fixture input, not something a spec can click its way to - a tournament
 * starts when a human calls the RPC and its start time has arrived. The two lifecycle
 * words therefore get one describe each, with the fixture told which to serve.
 */

const TOURNAMENT_NAME = "Layout Validation Invitational";

/** The all-false answer the database returns for someone with no owner or editor row. */
const VIEWER_ACCESS = {
  is_owner: false,
  is_editor: false,
  can_edit: false,
  can_manage_access: false,
};

/** Edit rights without ownership: can run the event, cannot decide who else may. */
const EDITOR_ACCESS = {
  is_owner: false,
  is_editor: true,
  can_edit: true,
  can_manage_access: false,
};

test.describe("a viewer", () => {
  test.use({
    appMock: { preset: "layout", role: "user", access: VIEWER_ACCESS },
  });

  test("is not handed somebody else's tournament as one of their own", async ({ page }) => {
    await page.goto(routes.myTournaments, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The page itself is not withheld: any signed-in person can create a tournament and own
    // it, so there is always something they can do here. Two links carry that label (the
    // header action and the empty state's), which is the page agreeing with itself.
    await expect(page.getByRole("link", { name: /new tournament/i }).first()).toBeVisible();

    // Owned by me is empty, and that is the assertion: the fixture tournament belongs to
    // somebody else and this caller holds no editor row, so listing it as theirs would be
    // exactly the "a session with no row is silently treated as an owner" failure.
    await expect(page.getByText(/you have not created a tournament/i)).toBeVisible();

    // And they are not an editor either, which is the other way a row could appear.
    await page.getByRole("button", { name: /shared with me/i }).click();
    await expect(page.getByText(/nobody has shared one with you/i)).toBeVisible();
    await expect(page.getByText(TOURNAMENT_NAME)).toHaveCount(0);

    // Scoped to `main`, which is the list, because the header is not this page's to assert:
    // since S6 it carries the public nav (now just Browse tournaments), whose entry is about
    // browsing rather than about a row - so an act on *this* tournament is a `main` question,
    // and the nav's absence of `Setup` is asserted where the workspace nav lives.
    const main = page.getByRole("main");
    await expect(main.getByRole("button", { name: /^delete$/i })).toHaveCount(0);
    await expect(main.getByRole("link", { name: /^setup$/i })).toHaveCount(0);
    await expect(main.getByText(/work in this one/i)).toHaveCount(0);
  });

  test("reads it on Explore, and is offered none of the acts on it", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // Public read is first class, so the card is on screen for anyone: a person deciding
    // whether to enter an event can see it before creating an account.
    const card = page.locator("li").filter({ hasText: TOURNAMENT_NAME }).first();
    await expect(card).toBeVisible();

    // What is withheld is every act on it. Explore passes no actions at all - it is the
    // browse surface, not the manage one - so an owner's controls appearing here would mean
    // the card had started deciding rights from a read.
    await expect(card.getByRole("button", { name: /^delete$/i })).toHaveCount(0);
    await expect(card.getByRole("link", { name: /^setup$/i })).toHaveCount(0);
    await expect(card.getByText(/work in this one/i)).toHaveCount(0);
    await expect(card.getByText(/working here/i)).toHaveCount(0);
  });

  test("gets no stage reset on the placement tab", async ({ page }) => {
    await page.goto(routes.placement, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The reset is the page's only header action, and it is hidden rather than disabled
    // for anyone without the edit right - so its absence is the whole header's actions.
    const header = page
      .locator("main > div")
      .filter({ has: page.getByRole("heading", { name: "Placement", level: 1 }) })
      .first();
    await expect(header.getByRole("button", { name: /^reset$/i })).toHaveCount(0);
  });

  // Each section has its own timeout and failure location. The same three navigations
  // used to share one 60-second budget, which failed on cold route transforms.
  test("shows the entries data without the operator's forms or row actions", async ({ page }) => {
    await page.goto(routes.entries, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Entries", level: 1 })).toBeVisible();
    for (const gone of [/add player/i, /add entry/i, /^withdraw$/i, /^reinstate$/i, /^remove$/i]) {
      await expect(page.getByRole("button", { name: gone })).toHaveCount(0);
    }
    // A form the reader cannot submit is a worse answer than no form: nothing in the page
    // body is an input or a select.
    await expect(page.locator("main input")).toHaveCount(0);
    await expect(page.locator("main select")).toHaveCount(0);
  });

  test("shows the running order without the operator's planning controls", async ({ page }) => {
    await page.goto(routes.schedule, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Running order" })).toBeVisible();
    for (const gone of [
      /tournament settings/i,
      /build schedule/i,
      /update schedule/i,
      /^show$/i,
      /^set courts$/i,
      /^unlock window$/i,
    ]) {
      await expect(page.getByRole("button", { name: gone })).toHaveCount(0);
    }
    await expect(page.getByRole("heading", { name: "Stage progress" })).toHaveCount(0);
    await expect(page.locator("main input")).toHaveCount(0);
    await expect(page.locator("main select")).toHaveCount(0);
  });

  test("shows the scores without opening a scoring dialog for a reader", async ({ page }) => {
    await page.goto(routes.scores, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Scores", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /^open$/i })).toHaveCount(0);
    await expect(page.getByPlaceholder(/search a player or pair/i)).toBeVisible();
  });

  test("is told the view is read-only, in the same treatment a visitor gets", async ({ page }) => {
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // A viewer and a signed-out visitor are the same fact - this caller may not change
    // anything here - so they get one treatment rather than two. What differs is the
    // sentence, because a viewer cannot buy the right by signing in again.
    await expect(page.getByText(/read-only view/i).first()).toBeVisible();
    await expect(page.getByText(/ask its owner for edit access/i).first()).toBeVisible();
  });

  test("is offered the read-only sections, and none of the acts", async ({ page }) => {
    await page.goto(routes.entries, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const nav = page.getByRole("navigation", { name: /tournament sections/i });
    // The sections reading a tournament is made of: the day's hall, the followed player, the
    // draws and who is playing. The operational pages stay reachable by URL - this one was
    // opened directly - but they are not the reader's nav.
    for (const label of ["Now", "My matches", "Draws", "Players"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: "Desk", exact: true })).toHaveCount(0);
    // What is withheld is the kind of act on the tournament: Setup and Access are about
    // configuring this tournament and deciding who else may operate it. A nav entry that
    // leads to a page saying no is a worse answer than not offering the trip, so the entries
    // are absent rather than disabled.
    await expect(nav.getByRole("link", { name: "Setup", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Access", exact: true })).toHaveCount(0);
  });

  test("is offered the way back to the list, and no act on the tournament", async ({ page }) => {
    await page.goto(routes.entries, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The entry that leaves a tournament follows the edit right rather than the session, so
    // a signed-in viewer and a signed-out visitor meet the same one: the public list a card
    // came in by, in the place `PublicShell` puts its public nav - beside the brand, on the
    // header's own line. The operator's switcher is not drawn for either of them, and
    // neither is the create flow it used to end on for a visitor.
    const header = page.getByRole("banner");
    await expect(header.getByRole("link", { name: "Browse tournaments" })).toHaveAttribute(
      "href",
      routes.explore,
    );
    await expect(header.getByRole("button", { name: /switch tournament/i })).toHaveCount(0);
    await expect(header.getByRole("link", { name: /create tournament/i })).toHaveCount(0);
  });

  test("sends the brand where a card opens the tournament", async ({
    page,
  }) => {
    // The logo is the one link outside the nav, and for a read-only reader it goes where a card
    // opens the tournament: Now, since this one is in progress (`readerHomeFor`).
    await page.goto(routes.entries, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    // The reader's sections are the Watch pages, named for a reader's questions.
    await expect(
      page.getByRole("navigation", { name: "Tournament sections" }).getByRole("link"),
    ).toHaveText(["Now", "My matches", "Draws", "Players"]);
    const header = page.getByRole("banner");
    await header.getByRole("link", { name: /tournova/i }).click();
    await expect(page).toHaveURL(new RegExp(`${routes.now}$`));
  });
});

test.describe("an editor", () => {
  // An upcoming event, because that is the status whose configuration is still editable: it
  // is where the Setup entry exists at all, so it is the status that can show the split
  // between the operation and the ownership.
  test.use({
    appMock: { preset: "layout", role: "user", status: "upcoming", access: EDITOR_ACCESS },
  });

  test("keeps the app's own navigation while inside a tournament", async ({ page }) => {
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // Opening a tournament must not take Browse, My tournaments and New tournament away from
    // the person running it: they are the app, and the sections below are the tournament.
    const header = page.getByRole("banner");
    const primary = header.getByRole("navigation", { name: "Primary" });
    await expect(primary.getByRole("link", { name: "Browse tournaments" })).toHaveAttribute(
      "href",
      routes.explore,
    );
    await expect(primary.getByRole("link", { name: "My tournaments" })).toHaveAttribute(
      "href",
      routes.myTournaments,
    );
    await expect(header.getByRole("link", { name: "New tournament" })).toHaveAttribute(
      "href",
      routes.newTournament,
    );
    // Two rows, two landmarks: the app, and this tournament's sections.
    await expect(header.getByRole("navigation", { name: /tournament sections/i })).toBeVisible();
  });

  test("sees the shared tournament, and may not delete it", async ({ page }) => {
    await page.goto(routes.myTournaments, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // An editor's tournaments are somebody else's, so they live under the second tab - and
    // the note says which relationship this is, because "shared with me" covers two.
    await page.getByRole("button", { name: /shared with me/i }).click();
    const row = page.locator("li").filter({ hasText: TOURNAMENT_NAME }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(/you are an editor/i)).toBeVisible();

    // The operation is offered - an editor runs the event, so Setup is theirs - and the
    // ownership act is not: deleting somebody else's tournament is the owner's alone.
    await expect(row.getByRole("link", { name: /^setup$/i })).toBeVisible();
    await expect(row.getByRole("button", { name: /^delete$/i })).toHaveCount(0);
  });

  test("sees the access list but cannot change it", async ({ page }) => {
    await page.goto(routes.access, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The panel is the owner's, so an editor is told who can and is not given the form.
    await expect(page.getByRole("heading", { name: /people who can edit/i })).toBeVisible();
    await expect(
      page.getByText(/only the owner of this tournament can change who may edit it/i),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /add editor/i })).toHaveCount(0);

    // And the list itself is theirs to read, because an edit right is a right to work in
    // the tournament. The owner is named and marked, the editor's own row is there too,
    // the count agrees with the rows, and the act that is the owner's alone is absent
    // rather than disabled.
    const list = page.getByRole("list").filter({ hasText: /@example\.test/ });
    await expect(list.getByText("host@example.test")).toBeVisible();
    await expect(list.getByText("desk@example.test")).toBeVisible();
    await expect(list.getByText(/^Owner$/)).toBeVisible();
    await expect(page.getByText(/2 people$/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^remove$/i })).toHaveCount(0);
  });
});

/**
 * The owner is the one caller who may decide the list, and until this pass no spec said so.
 *
 * The editor case proved the read half and the withholding; what was never asserted is the
 * half that changes the roster - which is the *point* of the page, and the only reason the
 * `add`/`remove` path exists. The fixture also had to learn to answer the list at all: it
 * returned `[]`, which for an editor rendered the "not yours to read" state and would have
 * passed the old assertions for the wrong reason.
 */
test.describe("the owner", () => {
  test.use({ appMock: { preset: "layout", role: "user", status: "upcoming" } });

  test("sees who can edit, and is offered both acts", async ({ page }) => {
    await page.goto(routes.access, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The sentence about who may change the list is for callers who cannot, so the absence
    // is the assertion here - a notice shown to the one person who *can* would be noise.
    await expect(
      page.getByText(/only the owner of this tournament can change who may edit it/i),
    ).toHaveCount(0);

    await expect(page.getByRole("button", { name: /add editor/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();

    // One row: this fixture's owner holds no membership row, and the owner is drawn from
    // the tournament's own column. So the count is one, the marker is on that row, and
    // Remove is absent on it rather than disabled - the database refuses to remove the
    // owner, and the button's absence is how the page says so without anyone finding out
    // by trying. Scoped to the list because the same address is in the shell's own session
    // chip, which is not this page's to assert.
    const list = page.getByRole("list").filter({ hasText: /@example\.test/ });
    await expect(page.getByText(/1 person$/)).toBeVisible();
    await expect(list.getByText("desk@example.test")).toBeVisible();
    await expect(list.getByText(/^Owner$/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^remove$/i })).toHaveCount(0);
  });
});

test.describe("a signed-out visitor", () => {
  test.use({ appMock: { preset: "layout", role: null } });

  test("reads the tournament, and is told the view is read-only", async ({ page }) => {
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // Public read is first class: the roster is on screen with no session at all.
    await expect(page.getByText(/Alexandra Kristinsson-Watanabe/).first()).toBeVisible();
    // And the read-only banner is the signed-out affordance, not a hidden control - a
    // visitor has no edit right to withhold, so the page says what signing in would buy.
    await expect(page.getByText(/read-only view/i).first()).toBeVisible();
    // The sentence is the visitor's, not the viewer's, and it is addressed to the one visitor
    // signing in helps: whoever runs the tournament. A spectator is not promised a right.
    await expect(page.getByText(/running this tournament\? sign in to operate it/i).first()).toBeVisible();
  });

  test("finds one player's matches across both stages, in a link that keeps the search", async ({
    page,
  }) => {
    await page.goto(routes.scores, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Search a player or pair…").fill("Kristinsson");

    // One list while a search is typed: the stage tabs split a player's matches in two.
    await expect(page.getByRole("heading", { name: 'Matches for "Kristinsson"' })).toBeVisible();
    await expect(page.getByRole("tab", { name: /group stage/i })).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]q=Kristinsson/);

    // And the address alone brings the same list back.
    await page.reload({ waitUntil: "load" });
    await expect(page.getByRole("heading", { name: 'Matches for "Kristinsson"' })).toBeVisible();
  });

  test("reads the running order on a phone as cards, with played matches folded away", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(routes.schedule, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The table is for a wider screen; a phone gets one card per match.
    await expect(page.locator("table.data-table").first()).toBeHidden();
    const toggle = page.getByRole("button", { name: /^Show \d+ played match/ });
    await expect(toggle).toBeVisible();
    const cards = page.locator("li", { hasText: " vs " });
    const before = await cards.filter({ visible: true }).count();
    await toggle.click();
    await expect(page.getByRole("button", { name: "Hide played matches" })).toBeVisible();
    expect(await cards.filter({ visible: true }).count()).toBeGreaterThan(before);
  });

  test("meets the same read-only surface a signed-in viewer does", async ({ page }) => {
    // A visitor has no edit right to withhold, so the pages must not read as a form they
    // are failing to fill in. Entries is the workspace a card opens them on.
    await page.goto(routes.entries, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Entries", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /add player/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /add entry/i })).toHaveCount(0);
    await expect(page.locator("main input")).toHaveCount(0);

    // The reader's nav is the Watch pages, and the Desk stays reachable by URL as a board:
    // nothing that starts a match.
    const nav = page.getByRole("navigation", { name: /tournament sections/i });
    await expect(nav.getByRole("link", { name: "Now", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Desk", exact: true })).toHaveCount(0);
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Court board" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^start$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Call next|Notified)/ })).toHaveCount(0);
  });

  test("can tell which tournament the page is about without signing in", async ({ page }) => {
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The workspace header is the one place that says which tournament a page belongs to,
    // and it is rendered for a visitor exactly as for anyone else: the address names it, so
    // reading it is not a privilege. Before the header was hoisted to the layout, a page
    // could only state what it was passed, and nothing stated the tournament.
    const header = page.getByRole("banner");
    await expect(header.getByText(TOURNAMENT_NAME)).toBeVisible();
    await expect(header.getByRole("navigation", { name: /tournament sections/i })).toBeVisible();
  });

  test("keeps the way back to the list after a card has been opened", async ({ page }) => {
    await page.goto(routes.explore, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // A card opens the read-only workspace, which is how a reader arrives at a tournament at
    // all. The entry they came in by is the one that gets them out, so opening a tournament
    // must not spend the header's public slot on something else - and it has to be in the
    // same place the list they left had it: beside the brand, not in the section row.
    await page.getByRole("link", { name: TOURNAMENT_NAME }).first().click();
    // An in-progress tournament opens on Now (`readerHomeFor`).
    await expect(page).toHaveURL(new RegExp(`${routes.now}$`));

    const header = page.getByRole("banner");
    const back = header.getByRole("link", { name: "Browse tournaments" });
    await expect(back).toHaveAttribute("href", routes.explore);
    // Above the section row rather than inside it, which is what "same place as the landing
    // page" means concretely and is the part a name-only assertion cannot see.
    const sections = header.getByRole("navigation", { name: /tournament sections/i });
    // Both are measured, so both are waited for. The section nav is drawn from the
    // tournament's own sections, which resolve *after* the header itself does, so measuring
    // straight after the click raced it. `boundingBox()` answers `null` for an element that
    // is not in the DOM yet, so the race surfaced as `Cannot read properties of null
    // (reading 'y')` on the line below rather than as a layout failure - and it was
    // intermittent, which is worse: it read as a flaky assertion instead of a measurement
    // taken too early. The `toHaveAttribute` above does not cover it, because an attribute
    // assertion is happy with an element that is present and says nothing about whether the
    // row this one must sit above has been drawn.
    await expect(back).toBeVisible();
    await expect(sections).toBeVisible();
    const [backBox, sectionsBox] = await Promise.all([back.boundingBox(), sections.boundingBox()]);
    expect(backBox!.y + backBox!.height).toBeLessThanOrEqual(sectionsBox!.y);
    // And it does not answer a reader by offering to start a tournament of their own.
    await expect(header.getByRole("link", { name: /create tournament/i })).toHaveCount(0);
  });
});

/**
 * The one control that changes which tournament you are working in.
 *
 * It is a control over the *caller's own pointer*, not a global act: selecting a row writes
 * `set_current_tournament`, which moves nobody but the person who clicked. The integration
 * suite proves that per-row claim against the real function; what this file can see, and the
 * database cannot, is whether the control tells the truth about itself - that it is a
 * disclosure rather than a menu, that it marks the tournament you are already in instead of
 * hiding it, and that a caller with nothing to switch to is offered the act that would
 * change that rather than an empty box.
 */
test.describe("the tournament switcher", () => {
  test.use({ appMock: { preset: "layout", role: "user" } });

  test("lists the caller's tournaments, marks the one you are in, and closes on Escape", async ({
    page,
  }) => {
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const header = page.getByRole("banner");
    const trigger = header.getByRole("button", { name: /switch tournament/i });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // The list is every tournament this caller runs, so the one they are in is *marked*
    // rather than withheld: choosing it is a no-op, and a list without it would answer
    // "where can I go" while losing "where am I".
    const item = header.locator("ul li button").first();
    await expect(item).toContainText(TOURNAMENT_NAME);
    await expect(item).toHaveAttribute("aria-current", "true");
    await expect(item.getByText(/working here/i)).toBeVisible();

    // Escape is a disclosure's own job - it is not in the browser's button semantics - so
    // it is asserted, and it has to hand focus back to the trigger rather than drop it at
    // the top of the document.
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });

  test("offers the act that would give an operator something to switch to", async ({ page }) => {
    /**
     * The one operator whose own list can be empty.
     *
     * The switcher is drawn with the edit right and nowhere else, so a viewer never meets
     * it - the caller this state belongs to is a platform admin, whose override is the one
     * way to edit a tournament you neither own nor edit. Nothing in the list is theirs, so
     * the panel answers with the act that would give them something rather than with an
     * apology.
     */
    await installAppMock(page, {
      preset: "layout",
      role: "admin",
      status: "upcoming",
      access: { is_owner: false, is_editor: false, can_edit: true },
    });
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const header = page.getByRole("banner");
    await header.getByRole("button", { name: /switch tournament/i }).click();
    await expect(header.getByText(/nothing to switch to/i)).toBeVisible();
    await expect(header.getByRole("link", { name: /create tournament/i })).toBeVisible();
  });

  test("is not drawn for a reader, because there is nothing it could offer", async ({ page }) => {
    // Re-installed signed out. The route-level mock is registered last and wins, which is
    // the harness's own documented way to vary a session mid-file.
    await installAppMock(page, { preset: "layout", role: null });
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const header = page.getByRole("banner");
    // The workspace renders it under the edit right and nowhere else, so a reader - a
    // visitor or a signed-in viewer - never meets it. What fills the slot for them is
    // asserted in `a signed-out visitor`, where the trip in from Explore is.
    await expect(header.getByRole("button", { name: /switch tournament/i })).toHaveCount(0);
    // And with it went the only way this header ever had of offering the create flow:
    // starting a tournament is an operator's act, and a read-only header offers none.
    await expect(header.getByRole("link", { name: /create tournament/i })).toHaveCount(0);
  });
});

test.describe("the workspace header", () => {
  test.use({ appMock: { preset: "layout", role: "admin", status: "in_progress" } });

  test("names the tournament's lifecycle status, with a glyph and a word", async ({ page }) => {
    await page.goto(routes.entries, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // Scoped to the header, because the same word appears in the setup list and in help
    // copy; a page-wide match would pass on prose rather than on the state.
    const header = page.getByRole("banner");
    // Read against the clock, a running tournament inside its playing days is "Live".
    const status = header.getByText(/^Live$/).first();
    await expect(status).toBeVisible();
    // Status is never colour alone: the pill carries a glyph and a label, and the label is
    // the display word rather than the stored `in_progress`.
    await expect(header.locator("span", { hasText: /^Live$/ }).first().locator("svg")).toHaveCount(1);
    await expect(header.getByText("in_progress")).toHaveCount(0);
  });

  test("offers every section to someone who may edit, and marks the one you are on", async ({
    page,
  }) => {
    await page.goto(routes.entries, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const nav = page.getByRole("navigation", { name: /tournament sections/i });
    for (const label of ["Desk", "Entries", "Placement", "Knockout", "Schedule", "Scores"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    // Setup and Access are about changing this tournament, so they are offered to the
    // people who can: the two entries are gated on the edit right rather than on a session.
    await expect(nav.getByRole("link", { name: "Setup", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Access", exact: true })).toBeVisible();

    // The current section is announced rather than only tinted: `aria-current` is what a
    // screen reader reads, and it is set by the router's own active-link handling.
    await expect(nav.getByRole("link", { name: "Entries", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("sends the brand to this tournament's desk, not to `/`", async ({ page }) => {
    await page.goto(routes.scores, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The logo used to point at `/` always, which after the workspace move would send a
    // host working in tournament B to whichever tournament their pointer named - possibly
    // A. A logo that moves you to a different event than the one on screen is worse than
    // one that does nothing.
    const header = page.getByRole("banner");
    await header.getByRole("link", { name: /tournova/i }).click();
    await expect(page).toHaveURL(new RegExp(`${routes.desk}$`));
  });

  test("is not told the view is read-only, because it is not", async ({ page }) => {
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The notice exists to stop someone operating a board they cannot act on. Showing it
    // to an editor would train them to ignore it, and the banner is only useful while it
    // means one thing.
    await expect(page.getByText(/read-only view/i)).toHaveCount(0);
  });
});

test.describe("an upcoming tournament", () => {
  test.use({ appMock: { preset: "layout", role: "admin", status: "upcoming" } });

  test("is labelled Upcoming on its card, in both words it carries", async ({ page }) => {
    // The fixture's playing day is today. Two days earlier it has not come yet, which is the
    // ordinary "upcoming" case; today itself, with no match started, reads "Not started".
    await page.clock.install({ time: new Date(Date.now() - 2 * 86_400_000) });
    await page.goto(routes.myTournaments, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // Scoped to the tournament's own card: the same word appears in help copy elsewhere on
    // the page, so an unscoped match would pass on prose rather than on the state.
    const row = page.locator("li").filter({ hasText: TOURNAMENT_NAME }).first();
    await expect(row.getByText(/^Upcoming/)).toBeVisible();
    await expect(row.getByText(/^In progress/)).toHaveCount(0);

    // The card carries two independent facts, and the second is not derived from the first:
    // the *lifecycle* is upcoming, while the *window* is not offered because this fixture
    // configures no registration window at all. A card that printed the status twice, or
    // that read "Not offered" off the lifecycle, would fail here.
    await expect(row.getByText(/^Not offered$/)).toBeVisible();
  });

  test("is marked Not started once its first day has begun and no match has", async ({ page }) => {
    await page.goto(routes.myTournaments, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // A reminder, not a transition: the stored status is still upcoming, and the card says
    // what the clock says. The mark is a word and a glyph, never a colour alone.
    const row = page.locator("li").filter({ hasText: TOURNAMENT_NAME }).first();
    await expect(row.getByText(/Not started/)).toBeVisible();
    await expect(row.getByText(/^Upcoming/)).toHaveCount(0);
  });
});

test.describe("a running tournament", () => {
  test.use({ appMock: { preset: "layout", role: "admin", status: "in_progress" } });

  test("is labelled Live, not Upcoming", async ({ page }) => {
    await page.goto(routes.myTournaments, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    const row = page.locator("li").filter({ hasText: TOURNAMENT_NAME }).first();
    await expect(row.getByText(/^Live/)).toBeVisible();
    await expect(row.getByText(/^Upcoming/)).toHaveCount(0);
    // A started tournament is not "closed for registration": the window reads `started`,
    // which is the lifecycle's answer rather than a timestamp comparison's.
    await expect(row.getByText(/^Started$/)).toBeVisible();
  });
});
