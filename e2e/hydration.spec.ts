import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";

import { MATRIX_CELLS, openCell } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";

/**
 * Hydration.
 *
 * This exists because a real defect hid behind the two blind spots the earlier gates had.
 * The Desk rendered a wall-clock time from `Date.now()` into the server HTML, so whenever
 * a minute boundary fell inside a page load React found the server text and the client text
 * disagreeing and, by design, threw the entire server-rendered subtree away and rebuilt it
 * on the client. That is a functional failure in production - the busiest screen of a live
 * event discards its server render, flickers, and repeats the work the server already did.
 *
 * The every-route mismatch check now lives in `route-sweep.spec.ts`, which listens for
 * hydration complaints on the same load as its other measurements. What stays here is the
 * specific regression, pinned by its cause.
 */

/**
 * The specific regression, pinned by its observable cause.
 *
 * The Desk's action panel used to print the current time straight into the server HTML.
 * Asserting on the mechanism rather than on "no console error" is deliberate: this fails if
 * the clock is ever server-rendered again, even at a moment when the minute does not happen
 * to tick during the load - which is the only reason the bug went unnoticed for so long.
 *
 * The clock is expected to *appear*, so the test also proves the fix did not simply delete
 * the time from the interface. It is read from an editor's Desk, whose console bar carries it.
 */
test.describe("the desk clock is client-owned", () => {
  test("the server render carries no wall-clock time", async ({ page }) => {
    // Blocking the bundle is the honest way to see the server HTML: with scripting live,
    // React has already replaced the tree by the time any assertion could read it.
    await page.route(/\.(js|mjs|tsx|ts)(\?|$)/, (route) => route.abort());
    const response = await page.goto(routes.desk, { waitUntil: "domcontentloaded" });

    // The clock sits in the Desk's header and is drawn only once the browser's clock has been
    // adopted, so the server never renders one. Reading the whole document rather than one
    // locator keeps the assertion true wherever the clock lives, since an HH:MM anywhere in the
    // server HTML still fails.
    const html = (await response?.text()) ?? "";
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      // Removes every tag, and with it every attribute - including `data-tsd-source`, whose
      // `file:line:column` values read as clock times.
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;|&#\d+;/gi, " ");
    expect(text, "server HTML contains a clock value").not.toMatch(/\d{1,2}:\d{2}/);
  });

  test("the clock appears once React has taken over", async ({ page }) => {
    // The clock is in the Desk's header, drawn once this browser's clock is adopted.
    await installAppMock(page, { role: "user" });
    await openCell(page, routes.desk, MATRIX_CELLS[0]!);
    const clock = page.locator("[data-desk-clock]").first();
    await expect(clock).toHaveText(/^\d{1,2}:\d{2}$/);
  });
});

/**
 * The server render carries no time-derived match text, and that is a property of the
 * architecture rather than a coincidence.
 *
 * After the clock was fixed, two other sites in the same file looked like the same bug
 * waiting to happen: the urgent-action list renders `N minutes — open the score desk` and
 * the court board renders `N min on court`, both computed from the same `now`. Both are
 * driven by `now`, so both would mismatch on exactly the same trigger.
 *
 * They cannot, and the reason is worth pinning rather than trusting. Every data hook in
 * this app is a client-side `useQuery` and nothing prefetches: there are no route
 * `loader`s, no `ensureQueryData`, no `prefetchQuery`, and the query cache is not
 * persisted, so it cannot be restored before the first render. The server therefore always
 * renders with `data === undefined`, and so does the client's first render - they agree by
 * construction. A list that is empty on both sides cannot disagree about how many minutes
 * have elapsed.
 *
 * That makes the clock special rather than representative: it is the only place `now` was
 * rendered *unconditionally*, with no data required to reach it. Everything else that
 * depends on `now` sits behind data that does not exist at server-render time.
 *
 * Which is exactly why this test asserts the precondition instead of the symptom. The
 * symptom cannot be reproduced, because forcing data into the server render is the very
 * thing that is absent. What *can* be done is to fail loudly if that ever changes: adding
 * a route loader or prefetching query data would make `now`-derived rendering a live
 * hazard across these pages, and the failure would otherwise appear as an intermittent
 * hydration error far from the commit that caused it.
 *
 * Tags and attributes are stripped before matching, and that is load-bearing rather than
 * tidy: the dev build emits `data-tsd-source="app-shell.tsx:217:7"` on every element, and
 * `217:7` matches a naive `\d{1,2}:\d{2}` clock pattern. A whole-document regex without
 * this step reports a wall-clock time in every server render and is simply wrong.
 */
test.describe("the server render carries no time-derived match text", () => {
  const ROUTES_WITH_TIME_TEXT = [routes.desk, routes.scores, routes.draws, routes.schedule] as const;

  for (const route of ROUTES_WITH_TIME_TEXT) {
    test(`${route} ships neither a clock nor elapsed minutes`, async ({ request }) => {
      const response = await request.get(route);
      expect(response.status()).toBeLessThan(500);

      const html = await response.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        // Removes every tag, and with it every attribute - including `data-tsd-source`,
        // whose `file:line:column` values read as clock times.
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z]+;|&#\d+;/gi, " ");

      expect(text, `${route} server HTML contains a wall-clock time`).not.toMatch(/\d{1,2}:\d{2}/);
      expect(text, `${route} server HTML contains elapsed minutes`).not.toMatch(
        /\d+\s*minutes?\s*[—–-]\s*open the score desk/i,
      );
      expect(text, `${route} server HTML contains an on-court timer`).not.toMatch(
        /\d+\s*(?:min|′)\s*on court/i,
      );
    });
  }
});
