import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { NO_POINTER_FALLBACK, legacyRoutes, routes } from "./fixtures/routes";

/**
 * The addresses, as a browser meets them.
 *
 * Two claims are made about the URL shape after the workspace move, and neither can be
 * checked from the source alone:
 *
 *  1. **A bookmark still works.** `src/lib/routing/workspace-redirect.ts` keeps a map of the
 *     flat addresses, and each one has to actually land on the page it names for a host who
 *     saved it before the move. The pairs come from `./fixtures/routes`, which is the same
 *     list the map is written against, so this file cannot assert a target the map does not
 *     name.
 *  2. **A page is about the tournament its address names.** Before the layout route owned
 *     the id, every operational page resolved "which tournament am I showing" from the
 *     caller's own pointer, so the same URL rendered a different tournament for each reader
 *     - and a caller with no pointer saw nothing at all. The id in the path is the subject
 *     now, and the `pointer: null` cases below are the evidence: the workspace renders, and
 *     a caller with no working tournament is sent somewhere that exists rather than into a
 *     stranger's event.
 *
 * ## Why these are browser tests and not a unit test of the redirect helper
 *
 * The redirect happens in an effect after hydration, on the client, because the pointer is
 * a session fact that does not exist during server rendering (see `workspace-redirect.tsx`).
 * A unit test of the helper would assert the map and prove nothing about whether the
 * resulting address resolves - which is exactly the failure mode M6 names.
 */

const TOURNAMENT_NAME = "Layout Validation Invitational";

/** An id no fixture serves, so the layout's own not-found branch is the only answer. */
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000ff";

/** Literal-safe use of a path inside a `RegExp`. */
function at(path: string): RegExp {
  return new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

test.describe("a flat address kept for bookmarks", () => {
  test.use({ appMock: { preset: "layout", role: "user" } });

  for (const { from, to } of legacyRoutes) {
    test(`${from} lands on ${to}`, async ({ page }) => {
      await page.goto(from, { waitUntil: "load" });

      // The redirect is client-side and follows the pointer's answer, so the assertion
      // polls rather than reading the URL once. The target is the whole claim: a flat path
      // that merely stopped 404ing would pass a "did it navigate" check and still lose the
      // page the bookmark meant.
      await expect(page).toHaveURL(at(to));
    });
  }

  test("resolves the bookmark to the page, not to an empty workspace", async ({ page }) => {
    await page.goto("/schedule", { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // Landing on the right URL and rendering the right page are two facts, and a redirect
    // that arrived before the route tree did would satisfy only the first. This is the one
    // address asserted through to content, as the representative of the group above.
    await expect(page.getByRole("heading", { name: "Court schedule", level: 1 })).toBeVisible();
  });
});

test.describe("a caller with no working tournament", () => {
  test.use({ appMock: { preset: "layout", role: "user", pointer: null } });

  test("is sent to Explore from a flat path, not into a stranger's tournament", async ({
    page,
  }) => {
    // The *flat* address, which is the one that has to resolve a pointer at all: the scoped
    // path names its subject and needs no pointer, which is the next test.
    await page.goto("/schedule", { waitUntil: "load" });
    await expect(page).toHaveURL(at(NO_POINTER_FALLBACK));
    await expect(page.getByRole("heading", { name: /explore tournaments/i })).toBeVisible();
  });

  test("is sent to Explore from the bare domain, which is the same answer", async ({ page }) => {
    // Both callers read one constant, and this is the second of them: a bookmark and a typed
    // domain have to land in the same place, or "no working tournament" would have two
    // meanings depending on how somebody arrived.
    await page.goto("/", { waitUntil: "load" });
    await expect(page).toHaveURL(at(NO_POINTER_FALLBACK));
  });

  test("still reads the workspace an address names, because the address is the subject", async ({
    page,
  }) => {
    await page.goto(routes.desk, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // This is the claim the layout route exists for. The caller has no pointer at all, so a
    // page that still resolved its subject from one would have nothing to render - and it
    // renders the tournament the URL names.
    await expect(page.getByRole("heading", { name: /control desk/i, level: 1 })).toBeVisible();
    await expect(page.getByRole("banner").getByText(TOURNAMENT_NAME)).toBeVisible();
  });
});

test.describe("an unknown tournament id", () => {
  test.use({ appMock: { preset: "layout", role: "user" } });

  test("is a missing page rather than an empty workspace", async ({ page }) => {
    await page.goto(`/tournaments/${UNKNOWN_ID}/desk`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // The alternative reading - render the shell and an empty board - would tell a host
    // that a tournament they have a link to has nothing in it, which is a worse lie than
    // saying the page is missing.
    await expect(page.getByText(/page not found/i)).toBeVisible();
  });

  test("is missing for a visitor as well, so the answer is not access-shaped", async ({
    page,
  }) => {
    // Re-installed signed out. The route-level mock is registered last and wins, which is
    // the harness's own documented way to vary a session mid-file.
    await installAppMock(page, { preset: "layout", role: null });
    await page.goto(`/tournaments/${UNKNOWN_ID}/schedule`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");

    // A viewer and an owner get the same answer about an id that does not exist: the
    // tournament is absent rather than withheld, and no "you may not see this" copy is
    // invented for it.
    await expect(page.getByText(/page not found/i)).toBeVisible();
  });
});
