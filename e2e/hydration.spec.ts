import { type ConsoleMessage, type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";

import { cellLabel, MATRIX_CELLS, openCell, ROUTES } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";

/**
 * Hydration, checked across the matrix.
 *
 * This exists because a real defect hid behind the two blind spots the earlier gates had.
 * The Desk rendered a wall-clock time from `Date.now()` into the server HTML, so whenever
 * a minute boundary fell inside a page load React found the server text and the client text
 * disagreeing and, by design, threw the entire server-rendered subtree away and rebuilt it
 * on the client. That is a functional failure in production - the busiest screen of a live
 * event discards its server render, flickers, and repeats the work the server already did.
 *
 * Nothing caught it. Axe does not look at hydration. The token and component tests never
 * run a second renderer. And the one existing mismatch test only checked a single route on
 * a fast local server, where the load reliably completes inside a single minute - so it
 * passed *because the clock rarely ticks mid-load*, which is the definition of a latent bug.
 *
 * What makes this check able to see what the old one could not is that every route is
 * checked, not just the Desk. The defect happened to be on the Desk, but the next one need
 * not be - so the sweep walks `ROUTES` through the shared `openCell` helper rather than
 * naming the pages it remembers.
 */

type Mismatch = { route: string; cell: string; message: string };

/**
 * Collects hydration complaints from both channels they can arrive on.
 *
 * React reports a hydration mismatch through `console.error`, not by throwing, so a page
 * that "loads fine" can still be discarding its entire server render. `pageerror` is
 * checked as well because a thrown error during hydration would otherwise be missed.
 */
function watchForMismatches(
  page: Page,
  sink: { route: string; cell: string; message: string }[],
  cell: string,
) {
  const record = (message: string) => {
    if (/hydrat/i.test(message)) sink.push({ route: page.url(), cell, message });
  };
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") record(message.text());
  });
  page.on("pageerror", (error: Error) => record(error.message));
}

test.describe("no route discards its server render", () => {
  // The sweep visits all 12 routes and then waits for the console to settle, so it needs
  // a budget sized for that rather than the 60s default.
  test.describe.configure({ timeout: 240_000 });

  for (const cell of MATRIX_CELLS) {
    test(`every route hydrates cleanly (${cellLabel(cell)})`, async ({ page }) => {
      const mismatches: Mismatch[] = [];
      watchForMismatches(page, mismatches, cellLabel(cell));

      for (const route of ROUTES) {
        await openCell(page, route, cell);
        // The mismatch is raised during hydration, which `openCell` has already waited
        // for. The settle gives React's console output a chance to reach the listener
        // before the next navigation.
        await page.waitForTimeout(250);
      }

      expect(
        mismatches,
        `hydration mismatches: ${mismatches
          .map((m) => `${m.route} — ${m.message.slice(0, 200)}`)
          .join(" | ")}`,
      ).toEqual([]);
    });
  }
});

/**
 * The specific regression, pinned by its observable cause.
 *
 * The Desk's action panel used to print the current time straight into the server HTML.
 * Asserting on the mechanism rather than on "no console error" is deliberate: this fails if
 * the clock is ever server-rendered again, even at a moment when the minute does not happen
 * to tick during the load - which is the only reason the bug went unnoticed for so long.
 *
 * The clock is expected to *appear*, so the test also proves the fix did not simply delete
 * the time from the interface.
 */
test.describe("the desk clock is client-owned", () => {
  test("the server render carries no wall-clock time", async ({ page }) => {
    // Blocking the bundle is the honest way to see the server HTML: with scripting live,
    // React has already replaced the tree by the time any assertion could read it.
    await page.route(/\.(js|mjs|tsx|ts)(\?|$)/, (route) => route.abort());
    await page.goto(routes.desk, { waitUntil: "domcontentloaded" });

    const panel = page.locator("text=updates every 30s").first();
    await expect(panel).toBeVisible();

    // Without the bundle nothing can have adopted the clock, so no HH:MM may be present.
    const text = (await panel.textContent()) ?? "";
    expect(text, `server HTML contains a clock value: "${text}"`).not.toMatch(/\d{1,2}:\d{2}/);
  });

  test("the clock appears once React has taken over", async ({ page }) => {
    await openCell(page, routes.desk, MATRIX_CELLS[0]!);
    const panel = page.locator("text=updates every 30s").first();
    await expect(panel).toHaveText(/\d{1,2}:\d{2}/);
  });
});

/**
 * The server render carries no time-derived match text, and that is a property of the
 * architecture rather than a coincidence.
 *
 * After the clock was fixed, two other sites in the same file looked like the same bug
 * waiting to happen: the urgent-action list renders `N minutes — open the score desk` and
 * the court board renders `N′ on court`, both computed from the same `now`. Both are
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
        /\d+\s*′\s*on court/i,
      );
    });
  }
});
