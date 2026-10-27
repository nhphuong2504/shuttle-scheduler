import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";

import {
  COURT_STATES,
  COURT_STATE_LABEL,
  type CourtState,
} from "../src/lib/tournament/court-state";
import {
  displayStateFor,
  MATCH_DISPLAY_LABEL,
  PERSISTED_MATCH_STATUSES,
} from "../src/lib/tournament/match-status";
import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { deskFixture, REFERENCE } from "./fixtures/desk-mock";
import { MATRIX_CELLS, WCAG_TAGS, cellLabel, openCell } from "./fixtures/matrix";
import { routes } from "./fixtures/routes";
import { settleAnimations } from "./fixtures/settle";

/**
 * Phase 6: every state and every urgency treatment, through the rendered app.
 *
 * ## What this file is for
 *
 * Phase 5 gave `void` a treatment and routed byes to a marker, and proved both in
 * jsdom. What jsdom cannot show is whether they resolve - whether the tokens a
 * component names produce a colour in a real cascade, at both densities, against a
 * court tile that is itself tinted. A class name that exists and
 * a colour that renders are different facts, and only one of them was checked.
 *
 * The other thing it does is populate the pages the existing gates scan. Every
 * accessibility scan before this phase ran against an empty tournament: the active
 * event has no courts, no teams and no matches, so the whole baseline measured
 * empty states and the components this redesign is aimed at were never scanned once.
 * A green scan of a blank page is not evidence about a court board.
 *
 * ## What it deliberately does not claim
 *
 * Match statuses are only partly reachable here. The running order at `routes.schedule`
 * renders without a session and is where the status vocabulary is swept, but it excludes
 * `void` by design - a void match never played, so it is not part of
 * a running order - and drops byes because they have no court or time. `void` and the
 * bye marker are therefore covered at the component level, not here, and the staff
 * surfaces behind `/matches` are still the four skipped specs in
 * `staff-surfaces.spec.ts`. This file does not close that gap and does not imply it has.
 *
 * ## The colour-vision checks
 *
 * The design's grayscale claim is that the state chips separate by lightness. That is
 * measurable, and measuring it requires compositing: `--primary/10` and
 * `--danger-surface/40` are translucent, so the chip a reader sees is the chip colour
 * over the tile colour over the page. Comparing the raw computed values would compare
 * two colours that are never on screen together.
 *
 * So each chip is flattened the way a browser paints it, then both transforms are
 * applied to the flattened result. Distances are asserted as *distinctness* and
 * reported as numbers. Deliberately no minimum margin is asserted: a threshold would
 * be a number chosen to pass, and the design's real defence against colour confusion
 * is that no state is colour alone, which is asserted separately.
 */

test.describe.configure({ timeout: 180_000 });

/**
 * The harness invariant this file depends on, asserted rather than assumed.
 *
 * Every state on this board is *derived* - `overrun` means a court has been live longer than
 * its slot - so the app's idea of "now" has to match the instants the fixture seeded. It did
 * not, once: the fixture clamped seeded times to just after midnight, so between 00:00 and
 * about 00:16 a board seeded to show all five states could not produce an `overrun` at all,
 * and this file failed for reasons unrelated to any change. CI runs in UTC, so that was a red
 * gate after every UTC midnight.
 *
 * Anchoring both clocks to `REFERENCE` fixes it, and the two must move together - reverting
 * either one alone re-opens the gap. This test fails if the pin is dropped, which is the
 * realistic way to reintroduce it, because a dropped pin is invisible at every other hour.
 */
test("the app clock is pinned to the fixture reference", async ({ page }) => {
  await installAppMock(page, { preset: "states" });
  await openCell(page, routes.desk, MATRIX_CELLS[0]!);

  const appNow = await page.evaluate(() => Date.now());
  expect(
    Math.abs(appNow - REFERENCE.getTime()),
    `the page clock drifted from the fixture reference by ${Math.round(
      (appNow - REFERENCE.getTime()) / 1000,
    )}s - derived states such as overrun are measured against it`,
  ).toBeLessThan(1_000);
});

/** The state vocabulary as the aria-label spells it: hyphens replaced by spaces. */
const ariaState = (state: CourtState) => state.replace("-", " ");

/**
 * The desk's Refresh control, resolved to the copy that is actually on screen.
 *
 * The Desk renders its controls twice - once in the page header, once in the console bar - and
 * lets a media query decide which is shown. `aria-busy` identifies the control without naming it,
 * which matters because its label is what these tests assert.
 */
const refreshButton = (page: Page) => page.locator("button[aria-busy]:visible");

/**
 * Click Refresh without racing the layout that owns it.
 *
 * The console bar exists only once `canEdit` resolves, so on a cold load the header copy is the
 * only one on screen and it is hidden (`desk-console:hidden`, a 0x0 box) as the bar mounts. That
 * window is what made these tests flaky: Playwright resolves a locator **once** and then retries
 * actionability on that same node, so a click bound to the header copy waited forever on a
 * control that had become 0x0 - measured as "element is not stable" followed by 29 attempts of
 * "element is not visible", with the visible copy sitting in the console bar the whole time.
 *
 * `toPass` re-runs the whole attempt, so every try resolves the selector again. This is the
 * documented remedy for an action whose target is legitimately replaced, and it keeps the tests
 * about the control's behaviour rather than about which of its two copies a click happens to hit.
 */
const clickRefresh = async (page: Page) => {
  await expect(async () => {
    await page.locator("button[aria-busy]:visible").first().click({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
};

test("Refresh fetches new court data and shows progress", async ({ page }) => {
  await installAppMock(page, { preset: "states", role: "user" });
  await page.goto(routes.desk);
  await expect(page.locator('[data-court-number="6"]')).toBeVisible();
  const courts = deskFixture("states", "user").tables["courts"] as { id: string; number: number }[];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/rest/v1/courts?*", async (route) => {
    await pending;
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(courts.map((court) => court.number === 6 ? { ...court, number: 9 } : court)),
    });
  });
  const refresh = refreshButton(page);
  try {
    await clickRefresh(page);
    // One control, three facts: it is busy, it is locked, and it says so. The label is
    // asserted through the same locator rather than a second one, because a label-only
    // locator is a second element to resolve in the middle of the re-render.
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toHaveText("Refreshing…");
  } finally {
    release();
  }
  await expect(page.locator('[data-court-number="9"]')).toBeVisible();
  await expect(page.locator('[data-court-number="6"]')).toHaveCount(0);
  await expect(page.getByText("Desk updated.", { exact: true })).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect(refresh).toHaveText("Refresh");
});

test("Refresh explains when the desk is offline", async ({ page, context }) => {
  await installAppMock(page, { preset: "states", role: "user" });
  await page.goto(routes.desk);
  const refresh = refreshButton(page);
  await expect(refresh).toBeVisible();
  await expect(page.locator('[data-court-number="6"]')).toBeVisible();
  await context.setOffline(true);
  try {
    // Going offline re-renders the desk: the badge, the paused bar above the board and the
    // Refresh button's own variant all change at once. Wait for the pause to land, then
    // click the button it left behind.
    await expect(page.locator("[data-desk-paused]")).toBeVisible();
    await clickRefresh(page);
    await expect(page.getByText("You are offline. Reconnect to refresh the desk.", { exact: true })).toBeVisible();
    await expect(refresh).toBeEnabled();
  } finally {
    await context.setOffline(false);
  }
});

test("an idle court offers no match, even while a ready one has no court", async ({ page }) => {
  // The preset holds a ready pairing with no court (desk-mock, match 7). An idle tile used to
  // offer it as "Place on this court" and start it there, which is how a match the plan had not
  // placed was started on Viet Nam Open 2026's day two. The tile now has nothing to open.
  await installAppMock(page, { preset: "states" });
  await page.goto(routes.desk);
  const idle = page.getByRole("button", { name: "Court 6: idle", exact: true });
  await expect(idle).toBeDisabled();
  await expect(page.getByText(/Place on this court|Ready to place/)).toHaveCount(0);
});

test("a match dialog on the Desk has no move control", async ({ page }) => {
  // Moving a match by hand was the other way to start one off the plan: move it onto an idle
  // court, then start it. Moving is the Schedule's now.
  await installAppMock(page, { preset: "states" });
  await page.goto(routes.desk);
  await page.getByRole("button", { name: "Court 3: free ready", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Move \/ delay/ })).toHaveCount(0);
  await expect(dialog.getByText("Check constraints and update")).toHaveCount(0);
});

test("court labels stay on one line in the running order at every density", async ({ page }) => {
  await installAppMock(page, { preset: "states", role: "user" });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(routes.schedule);
    const order = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Running order", exact: true }),
    });
    await expect(order.getByText("Unassigned", { exact: true }).filter({ visible: true })).toBeVisible();
    const labels = order.getByText(/^(Court \d+|Unassigned)$/).filter({ visible: true });
    expect(await labels.count()).toBeGreaterThan(0);
    for (const label of await labels.all()) {
      const lines = await label.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      });
      expect(lines, `${width}px: ${await label.textContent()}`).toBe(1);
    }
  }
});

test("Desk cards leave room for the match action beside Call next", async ({ page }) => {
  await installAppMock(page, { preset: "states", role: "user" });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(routes.desk);
    const court = page.locator('[data-court-number="3"]');
    const action = court.getByText("Open next match", { exact: true });
    const call = court.getByRole("button", { name: /^Call next, Court 3/ });
    await expect(action).toBeVisible();
    await expect(call).toBeVisible();
    const actionText = await action.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = [...range.getClientRects()];
      return { right: Math.max(...rects.map((rect) => rect.right)), lines: rects.length };
    });
    const callBounds = await call.boundingBox();
    expect(actionText.right, `${width}px: match action overlaps Call next`).toBeLessThan(callBounds!.x);
    expect(actionText.lines, `${width}px: match action is squeezed`).toBeLessThanOrEqual(width === 320 ? 2 : 1);
    expect(await court.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});

interface Chips {
  state: string;
  label: string | null;
  fill: Rgb;
  ink: Rgb;
  tileBorder: Rgb;
  /**
   * The tile's own background, flattened.
   *
   * Added because `fill` alone could not answer the question the pill has to: is the pill a
   * *discrete surface* on the tile it sits on. A pill whose fill equals its tile's is not a
   * container, however legible its ink is - `playing` shipped that way, with the tile painting
   * the same `--state-live-chip` the pill did, so a "Playing" chip read as uppercase text on
   * green with no edge at all.
   */
  tile: Rgb;
}

type Rgb = [number, number, number];

/**
 * Sentinel for "the element I was measuring left the document mid-read".
 *
 * It is a sentinel rather than a plain throw because the caller retries on it. The
 * reason it needs one at all: a detached element still answers `getComputedStyle`, with
 * every property at its initial value, so a re-render during the read hands back a set
 * of identical colours that reads as "every state shares a fill" rather than as a
 * failure. That is the failure mode that was seen once under full-suite contention,
 * where it is reported as a design defect that does not exist.
 */
const DETACHED = "<<detached>>";

/**
 * Reads every court tile and flattens the colours the way the browser paints them.
 *
 * All of the colour work happens in the page because the computed values come back as
 * `oklch()` and `oklab(...)`, and the canvas is the one parser guaranteed to agree
 * with the renderer about what they mean. A hand-written OKLCH conversion in the test
 * would be a second implementation of the same standard, which is the kind of thing
 * that agrees with itself and disagrees with the browser.
 *
 * The read is retried, because the board it reads is live: the desk re-renders on a
 * refetch, and a read that straddles one measures half an old tree. Retrying is the
 * honest response - the alternative is a colour assertion that is occasionally about
 * elements that are no longer on screen.
 *
 * ## Two waits that are not optional
 *
 * The tiles have `transition-all`, so their border colour *animates* into place after
 * mount, and `getComputedStyle` during that animation returns the previous colour rather
 * than the final one. Measured on this board, the borders start as the shared hairline and
 * take about 190ms to reach their real colours, which means for that window every tile's
 * edge reads identically. That is not a hypothesis: sampling every animation frame from
 * before first paint shows exactly it -
 *
 *   distinct=1/8  oklch(0.915 0.006 250)   <- every tile, the hairline
 *   distinct=2/8  oklab(0.915 -0.00205212 ...)
 *   distinct=4/8  oklch(0.875 0.055 27)    <- settled
 *
 * - and it is what a CI run reported as `playing=224,227,231, overrun=224,227,231, ...`,
 * every state sharing one edge. The board's pills were fine because they carry no
 * transition, which is the asymmetry that made this look like a token defect.
 *
 * So the read waits for the tiles to exist, waits for their transitions to finish, and
 * then requires two consecutive identical reads. The stability check is what makes it
 * correct rather than merely slower: if the class change lands between settling and
 * reading, the next iteration sees the transition that just started, and the loop only
 * returns once two reads agree. Nothing is applied to the page to force this - the colours
 * measured are the ones a reader gets.
 */
const COURT_TILE = "button[aria-label^='Court ']";

async function readCourtChips(page: Page): Promise<Chips[]> {
  await page.locator(COURT_TILE).first().waitFor({ state: "attached", timeout: 20_000 });

  let previous: string | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await settleAnimations(page, COURT_TILE);
      const chips = await readCourtChipsOnce(page);
      const signature = JSON.stringify(chips);
      if (signature === previous) return chips;
      previous = signature;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(DETACHED)) throw error;
      // A re-render invalidates the previous signature, so the next read must stand alone.
      previous = null;
    }
  }
  throw new Error("the court board never settled to a stable set of colours");
}

async function readCourtChipsOnce(page: Page): Promise<Chips[]> {
  return page.evaluate((detached) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d")!;

    /**
     * Any CSS colour to sRGB via the browser's own parser.
     *
     * The sentinel is load-bearing. `ctx.fillStyle` is specified to *ignore* an
     * assignment it cannot parse rather than throw, so the failure mode of a colour
     * this canvas does not understand is that it silently keeps the previous value -
     * and the caller gets a plausible number for a colour that was never read. That is
     * how an earlier version of this sweep could have reported two states as sharing a
     * fill when the real problem was that neither had been measured. Painting a known
     * sentinel first turns that into a named failure.
     */
    const SENTINEL = "#010203";
    const toRgb = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = css;
      if (ctx.fillStyle === SENTINEL && css.trim().toLowerCase() !== SENTINEL) {
        throw new Error(`the canvas could not parse the colour ${JSON.stringify(css)}`);
      }
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
    /** `src` over `dst`, both non-premultiplied. */
    const over = (
      src: [number, number, number, number],
      dst: [number, number, number, number],
    ): [number, number, number, number] => [
      src[0] * src[3] + dst[0] * dst[3] * (1 - src[3]),
      src[1] * src[3] + dst[1] * dst[3] * (1 - src[3]),
      src[2] * src[3] + dst[2] * dst[3] * (1 - src[3]),
      src[3] + dst[3] * (1 - src[3]),
    ];

    // The page itself is the bottom of the stack. `--background` is the token the
    // stylesheet paints the page with, so reading it keeps this honest rather than
    // assuming white.
    const rootBackground = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    const floored = (chain: [number, number, number, number][]) => {
      let acc = rootBackground
        ? toRgb(rootBackground)
        : ([255, 255, 255, 1] as [number, number, number, number]);
      for (const colour of chain) acc = over(colour, acc);
      return [acc[0], acc[1], acc[2]] as [number, number, number];
    };

    /** Every background from just above the element up to the root, then flattened. */
    const flattenAbove = (el: Element): [number, number, number] => {
      const chain: [number, number, number, number][] = [];
      let node: Element | null = el.parentElement;
      while (node) {
        chain.push(toRgb(getComputedStyle(node).backgroundColor));
        node = node.parentElement;
      }
      return floored(chain.reverse());
    };

    return [...document.querySelectorAll("button[aria-label^='Court ']")].map((el) => {
      // Detachment is checked before anything is read, because every read below would
      // otherwise return the initial value and quietly agree with its neighbours.
      if (!el.isConnected) throw new Error(`${detached} a court tile left the document mid-read`);
      const aria = el.getAttribute("aria-label") ?? "";
      const pill = [...el.querySelectorAll("span")].find(
        (s) =>
          typeof s.className === "string" &&
          s.className.includes("uppercase") &&
          s.children.length === 0,
      );
      const pillStyle = pill ? getComputedStyle(pill) : null;
      const behindTile = flattenAbove(el);
      const tile = over(toRgb(getComputedStyle(el).backgroundColor), [...behindTile, 1] as [
        number,
        number,
        number,
        number,
      ]);

      return {
        state: (aria.split(": ")[1] ?? "").replace(" ", "-"),
        label: pill?.textContent?.trim() ?? null,
        fill: floored([toRgb(pillStyle?.backgroundColor ?? "transparent")]),
        ink: floored([toRgb(pillStyle?.color ?? "transparent")]),
        tile: [Math.round(tile[0]), Math.round(tile[1]), Math.round(tile[2])] as Rgb,
        // The border is composited over the tile's own background, not the page: the
        // default background-clip is border-box, so the tile's fill already sits under
        // its edge. Both of the translucent edges here depend on that - `playing`'s edge
        // is a 35% ink over the live chip - and over the page they would be measured as
        // a different colour than the one painted.
        tileBorder: (() => {
          const edge = toRgb(getComputedStyle(el).borderTopColor);
          return [
            Math.round(edge[0] * edge[3] + tile[0] * (1 - edge[3])),
            Math.round(edge[1] * edge[3] + tile[1] * (1 - edge[3])),
            Math.round(edge[2] * edge[3] + tile[2] * (1 - edge[3])),
          ] as Rgb;
        })(),
      };
    });
  }, DETACHED);
}

/** WCAG relative luminance, and the linearisation it needs. */
const luminance = ([r, g, b]: Rgb): number => {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** WCAG contrast between two opaque sRGB colours. */
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Deuteranopia simulation, Machado et al. (2009), severity 1.0.
 *
 * Applied in linear light, which is where the deficiency actually lives - running it
 * on gamma-encoded values is a common mistake that understates the collapse it is
 * supposed to be testing for.
 */
const deuteranopia = ([r, g, b]: Rgb): Rgb => {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const enc = (c: number) => {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  return [
    enc(0.367322 * lr + 0.860646 * lg - 0.227968 * lb),
    enc(0.280085 * lr + 0.672501 * lg + 0.047413 * lb),
    enc(-0.01182 * lr + 0.04294 * lg + 0.968881 * lb),
  ];
};

/** A stable string key for a colour, so distinctness is a Set comparison. */
const key = (c: Rgb) => c.map((v) => Math.round(v)).join(",");

for (const cell of MATRIX_CELLS) {
  test.describe(cellLabel(cell), () => {
    /**
     * The pill has to be a *surface*, not text on the card.
     *
     * `playing` shipped with its tile painting the full `--state-live-chip` - the same fill
     * the pill paints - so a moderator saw the word "Playing" in green ink on a green card
     * with no chip around it, while "Ready" read clearly because its tile is a 5% wash under
     * a 10% pill. Measured on the board the two were byte-identical.
     *
     * So this states the requirement the design has for every state: the chip's fill must
     * differ from the tile it sits on. A colour alone is not the whole signal - the label
     * and the tile edge carry it too - but a chip painted in its own background is not a
     * discrete indicator at all, and nothing was measuring that.
     *
     * The floor is not chosen to pass. It is the smallest separation the *already shipped*
     * treatments produce, measured on this board: `free-ready` at 8.1 of Euclidean RGB
     * distance against the 0.0 that `playing` had, with the other states running 18-40. A
     * change can therefore improve on the design's own tightest case but cannot go below it
     * and call itself a chip.
     */
    const TILE_SEPARATION_MIN = 8;

    test("every court state chip is a discrete surface on its own tile", async ({ page }) => {
      await installAppMock(page, { preset: "states" });
      await openCell(page, routes.desk, cell);

      const chips = await readCourtChips(page);
      const byState = new Map(chips.map((chip) => [chip.state, chip]));

      const failures: string[] = [];
      const distances: string[] = [];
      for (const state of COURT_STATES) {
        const chip = byState.get(state);
        expect(chip, `no court rendered the ${state} state`).toBeDefined();
        if (!chip) continue;
        const delta = Math.sqrt(
          (chip.fill[0] - chip.tile[0]) ** 2 +
            (chip.fill[1] - chip.tile[1]) ** 2 +
            (chip.fill[2] - chip.tile[2]) ** 2,
        );
        distances.push(`${state}=${delta.toFixed(1)}`);
        if (delta < TILE_SEPARATION_MIN) {
          failures.push(
            `${state} ${COURT_STATE_LABEL[state]}: the chip and its tile are ${delta.toFixed(1)} ` +
              `apart (tile ${key(chip.tile)}, chip ${key(chip.fill)}) - a chip painted in its ` +
              `own card background has no container`,
          );
        }
      }
      expect(
        failures,
        `court state chips that are not a discrete surface; all separations: ` +
          distances.join(", "),
      ).toEqual([]);
      console.log(`[chip vs tile ${cellLabel(cell)}] ${distances.join(", ")}`);
    });

    test("every court state renders, with its own label and its own fill", async ({ page }) => {
      await installAppMock(page, { preset: "states" });
      await openCell(page, routes.desk, cell);

      const chips = await readCourtChips(page);
      expect(chips.length, "no court tiles rendered").toBeGreaterThan(0);

      const byState = new Map(chips.map((chip) => [chip.state, chip]));

      // Reachability: all five states are on the board at once, which is the thing a
      // live tournament can never show and the reason this needs a fixture.
      for (const state of COURT_STATES) {
        const chip = byState.get(state);
        expect(chip, `no court rendered the ${state} state`).toBeDefined();
        expect(chip?.label, `${state} did not render its label`).toBe(COURT_STATE_LABEL[state]);
      }

      // No state invented on the way out, either: the aria-label is built from the
      // derived state, so anything unknown here would be a state with no vocabulary.
      for (const chip of chips) {
        expect(COURT_STATES as readonly string[]).toContain(chip.state);
      }

      // Distinctness of the flattened fills: the chip a moderator actually sees.
      const fills = [...new Set([...byState.values()].map((chip) => key(chip.fill)))];
      expect(fills, "two court states resolved to the same visible fill").toHaveLength(
        COURT_STATES.length,
      );

      // And distinctness of the tile edge, which is the second channel - except for
      // the two states the design deliberately shares an edge between.
      //
      // These are reported rather than merely counted, which is how the intermittent
      // collapse below was diagnosed: a count of one says nothing about which states
      // came out equal or what they resolved to, and the raw computed border colours
      // are distinct in every cell, so the answer had to be in the flattening.
      const edges = new Map(chips.map((chip) => [chip.state, key(chip.tileBorder)]));
      // Playing, Waiting and Idle ask for nothing, so they share the resting hairline and
      // leave a tinted edge to the two states that need a hand.
      const resting = ["playing", "free-blocked", "idle"] as const;
      for (const state of resting) {
        expect(
          edges.get(state),
          `${state} ${edges.get(state)} vs idle ${edges.get("idle")} - the states that ask ` +
            `for nothing are supposed to share the resting hairline`,
        ).toBe(edges.get("idle"));
      }
      const actionable = COURT_STATES.filter(
        (state) => !(resting as readonly string[]).includes(state),
      );
      const collapsed = actionable.filter(
        (state, i) => actionable.findIndex((other) => edges.get(other) === edges.get(state)) !== i,
      );
      expect(
        collapsed.map((state) => `${state}=${edges.get(state)}`),
        `actionable states sharing a tile edge; all edges: ` +
          COURT_STATES.map((s) => `${s}=${edges.get(s)}`).join(", "),
      ).toEqual([]);
    });

    /**
     * Phase 6 added this because the only scan that had ever run over these chips ran
     * against an empty tournament, where no court tile is toned and no chip exists.
     * When the sweep finally gave the board data, light mode failed at 4.41:1 on the
     * ready chip: a tint of `/12` that no ink had been solved against.
     *
     * Axe catches that, and this is deliberately not a duplicate of axe. Axe reports a
     * pass or fail for the elements it happens to find; this states the requirement
     * against every state in the vocabulary, so a chip added later cannot be exempt by
     * simply not being scanned, and the threshold that failed is written down next to
     * the reason. The chip is 14px at normal weight, so the bar is 4.5:1 rather than the
     * 3:1 that large text is allowed.
     */
    test("every court state chip clears 4.5:1 between its ink and its fill", async ({ page }) => {
      await installAppMock(page, { preset: "states" });
      await openCell(page, routes.desk, cell);

      const chips = await readCourtChips(page);
      const byState = new Map(chips.map((chip) => [chip.state, chip]));

      const failures: string[] = [];
      for (const state of COURT_STATES) {
        const chip = byState.get(state);
        expect(chip, `no court rendered the ${state} state`).toBeDefined();
        if (!chip) continue;
        const ratio = contrast(chip.fill, chip.ink);
        if (ratio < 4.5) {
          failures.push(
            `${state} ${COURT_STATE_LABEL[state]}: ${ratio.toFixed(2)}:1 ` +
              `(fill ${key(chip.fill)} on ink ${key(chip.ink)})`,
          );
        }
      }
      expect(failures, "state chips under the 4.5:1 bar").toEqual([]);
    });

    test("going offline pauses the Desk: says since when, marks the board, locks writes", async ({
      page,
    }) => {
      await installAppMock(page, { preset: "states", role: "user" });
      await openCell(page, routes.desk, cell);
      await expect(page.getByRole("heading", { name: "Court board" })).toBeVisible();

      await page.context().setOffline(true);

      await expect(page.getByText(/No updates since \d{1,2}:\d{2}\./)).toBeVisible();
      // The board says what moment its numbers are from.
      await expect(page.getByText(/^as of \d{1,2}:\d{2}$/)).toHaveCount(1);

      // Opening a match still works - it is a read - but nothing in it writes. Court 3 is the
      // preset's free court with a ready match, so its tile opens a match that could start.
      await page.getByRole("button", { name: "Court 3: free ready", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(/No connection since/)).toBeVisible();
      await expect(dialog.getByRole("button", { name: /Start match/ })).toBeDisabled();

      await page.context().setOffline(false);
    });

    test("the state chips survive grayscale and deuteranopia", async ({ page }) => {
      await installAppMock(page, { preset: "states" });
      await openCell(page, routes.desk, cell);

      const chips = await readCourtChips(page);
      const byState = new Map(chips.map((chip) => [chip.state, chip]));

      const grey = new Map<string, number>();
      const deut = new Map<string, Rgb>();
      for (const state of COURT_STATES) {
        const chip = byState.get(state)!;
        grey.set(state, luminance(chip.fill));
        deut.set(state, deuteranopia(chip.fill));
      }

      const greyValues = [...grey.values()].map((v) => v.toFixed(4));
      expect(
        new Set(greyValues).size,
        `two states collapsed to one grayscale value: ${JSON.stringify(Object.fromEntries(grey))}`,
      ).toBe(COURT_STATES.length);

      const deutValues = [...deut.values()].map(key);
      expect(
        new Set(deutValues).size,
        `two states collapsed under deuteranopia: ${JSON.stringify(Object.fromEntries([...deut].map(([s, c]) => [s, key(c)])))}`,
      ).toBe(COURT_STATES.length);

      // Reported rather than asserted. These are the numbers the canvas carries as
      // evidence; a minimum margin would be a threshold picked to pass.
      console.log(
        `[${cellLabel(cell)}] state chips` +
          [...grey].map(([s, v]) => `\n  ${s.padEnd(12)} grey ${v.toFixed(4)}`).join("") +
          [...deut]
            .map(
              ([s, c]) =>
                `\n  ${s.padEnd(12)} deut ${c.map((n) => String(n).padStart(3)).join(" ")}`,
            )
            .join(""),
      );
    });

    test("the running order renders the status vocabulary it can hold", async ({ page }) => {
      // The layout preset, not the states preset: the archived statuses live there,
      // because a match that has finished only needs to exist to be drawn.
      await installAppMock(page, { preset: "layout" });
      await openCell(page, routes.schedule, cell);

      // Scoped to the running-order panel, not the document. The workspace chrome now
      // draws a lifecycle pill of its own ("In progress"), which is tournament state and
      // not a match status; a page-wide sweep would flag the shell for a vocabulary it
      // does not belong to, and loosening the vocabulary to admit it would let a real
      // invented match status through. The panel is found by its heading because that is
      // what a reader uses to find it.
      const pills = await page.evaluate(() => {
        const order = [...document.querySelectorAll("section")].find((section) =>
          [...section.querySelectorAll("h2")].some(
            (heading) => heading.textContent?.trim() === "Running order",
          ),
        );
        return [
          ...new Set(
            [...(order?.querySelectorAll("span") ?? [])]
              .filter((el) => el.querySelector("svg") && (el.textContent ?? "").trim())
              .map((el) => el.textContent!.trim()),
          ),
        ].sort();
      });

      const vocabulary = new Set(
        PERSISTED_MATCH_STATUSES.map(
          (status) => MATCH_DISPLAY_LABEL[displayStateFor(status) ?? "scheduled"],
        ),
      );

      // Nothing invented: every label on screen is one the vocabulary defines. This is
      // what would fail if a status reached the pill with no display state, which is
      // how `void` used to render as its own raw key.
      for (const label of pills) {
        expect(vocabulary, `${label} is not a label the vocabulary defines`).toContain(label);
      }

      // The reachable half. The running order is the one surface that draws statuses
      // without a session, so this is the widest rendered sweep the status vocabulary
      // gets outside the staff suite.
      expect(pills).toEqual(["Completed", "Live", "Scheduled", "Walkover"]);

      // And the unreachable one, named rather than glossed. `void` is filtered out of
      // the running order because a void match never played, so its absence here is
      // the route's rule and not a missing treatment - the component tests cover it.
      const absent = PERSISTED_MATCH_STATUSES.filter(
        (status) => !pills.includes(MATCH_DISPLAY_LABEL[displayStateFor(status) ?? "scheduled"]),
      );
      expect(absent).toEqual(["void"]);

      console.log(`[${cellLabel(cell)}] running-order statuses: ${pills.join(", ")}`);
    });

    test("a populated desk introduces no new a11y violation", async ({ page }) => {
      // The gap this closes: every scan before this phase ran against an empty
      // tournament, so the court board, the KPI row and the alert list - the surfaces
      // the redesign exists for - had never been scanned with content in them.
      await installAppMock(page, { preset: "states" });
      await openCell(page, routes.desk, cell);

      const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
      const ids = results.violations.map((v) => v.id).sort();
      if (ids.length) console.log(`[${cellLabel(cell)}] desk violations: ${ids.join(", ")}`);
      expect(ids).toEqual([]);
    });

    test("the day's pace count says what it counts, and what it leaves out", async ({ page }) => {
      // The count reads "12 of 16 matches done" and is drawn from the matches *placed on this
      // day's courts*. A match that has been generated but not yet given a court and time
      // belongs to no day, so it is in neither number - and a moderator reading the count
      // had no way to know that from the line itself.
      await installAppMock(page, { preset: "states" });
      await openCell(page, routes.desk, cell);

      const trigger = page.getByRole("button", { name: "What this count includes" });
      await expect(trigger).toBeVisible();

      // Closed until asked for: the visible line stays what the reader acts on.
      await expect(page.getByText(/generated but not yet given a court/)).toHaveCount(0);

      await trigger.click();
      const note = page.getByText(/generated but not yet given a court/);
      await expect(note).toBeVisible();

      // The two things a reader would otherwise get wrong: an unplaced match is missing from
      // both numbers, and a void match is in neither.
      await expect(page.getByText(/not counted here/)).toBeVisible();
      await expect(page.getByText(/void match is left out of both numbers/)).toBeVisible();
      // A walkover is done, which is why it is in the first number.
      await expect(page.getByText(/walkover counts as done/)).toBeVisible();
    });

    test("a populated running order introduces no new a11y violation", async ({ page }) => {
      await installAppMock(page, { preset: "layout" });
      await openCell(page, routes.schedule, cell);

      const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
      const ids = results.violations.map((v) => v.id).sort();
      if (ids.length)
        console.log(`[${cellLabel(cell)}] running-order violations: ${ids.join(", ")}`);
      expect(ids).toEqual([]);
    });

    test("the stage progress panel walks one pipeline, in matches", async ({ page }) => {
      /**
       * The panel this replaces changed units with its own state: before round two existed it
       * counted pending round-one matches, and once round two existed it counted entrants still
       * short of a result. The same line therefore meant two different things depending on which
       * stage an event had reached.
       *
       * The rows look the same as they always have; what changed is what they say. Only the
       * browser can confirm the panel the desk is actually shown is the one that was designed.
       *
       * The fixture is exactly the combination the old wording got wrong: a seeded field with no
       * placement matches, and two brackets already running. So the panel is asked to draw a
       * waiting round, a round waiting on that one, and a live bracket at once.
       *
       * The panel belongs to the editor, so this runs with an edit right. A visitor and a
       * signed-in viewer are shown the running order without it — the read-only surface
       * carries no tournament-wide forecast.
       */
      await installAppMock(page, { preset: "layout", role: "admin" });
      await openCell(page, routes.schedule, cell);

      const panel = page.locator("section", {
        has: page.getByRole("heading", { name: "Stage progress" }),
      });

      const lines = await panel.locator("li").allTextContents();
      expect(lines.length, "no stage rows rendered").toBeGreaterThan(0);

      // One unit for the whole panel, and the gate's entrant shortfall is not it.
      expect(lines.join("\n")).not.toMatch(/entrant/i);

      const counted = lines.filter((line) => line.includes("matches completed"));
      expect(counted.length, "no stage reported a match count").toBeGreaterThan(0);
      for (const line of counted) {
        expect(line, `not a match count: ${line}`).toMatch(/\d+ \/ \d+ matches completed/);
      }

      // The bracket's size comes from the draw rather than from the rows that exist. Each of the
      // fixture's two brackets holds twelve entrants, which plays eleven matches — a count taken
      // from the generated rows would read far lower while the bracket is still opening.
      for (const line of counted.filter((entry) => entry.includes("Knockout"))) {
        expect(line, `knockout is not sized from its draw: ${line}`).toContain(
          "/ 11 matches completed",
        );
      }

      // Every event runs the same pipeline in the same order, which is the point of it. The
      // fixture holds two events, and the knockout is last in both.
      const stages = lines.map(
        (line) =>
          line.match(/^[✓●○]\s*(Round 1|Round 2|Knockout|Tournament Complete)/)?.[1] ??
          `not a stage: ${line.slice(0, 40)}`,
      );
      expect(stages).toEqual([
        "Round 1",
        "Round 2",
        "Knockout",
        "Round 1",
        "Round 2",
        "Knockout",
      ]);

      // The next step is named where the readiness text used to sit: a stage that can be created
      // says so, and the running bracket says how much of it is left rather than how many
      // entrants are short.
      await expect(panel.getByText("Generate Round 1").first()).toBeVisible();
      await expect(panel.getByText("Waiting on Round 1").first()).toBeVisible();
      await expect(panel.getByText("9 matches remaining").first()).toBeVisible();
    });

    test("a court tile takes a visible focus ring", async ({ page }) => {
      // The focus sweep in `route-sweep.spec.ts` walks every route in every cell, but it
      // walks them empty. A ring can be clipped by the tile that contains it, so the
      // populated tile is the case worth stating separately.
      await installAppMock(page, { preset: "states" });
      await openCell(page, routes.desk, cell);

      await page.locator("button[aria-label^='Court ']").first().focus();
      const ring = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          label: el.getAttribute("aria-label"),
          visible: style.outlineStyle !== "none" || style.boxShadow !== "none",
          width: style.outlineWidth,
        };
      });
      expect(ring, "focus did not land on a court tile").not.toBeNull();
      expect(ring?.visible, `no focus indicator on ${ring?.label}`).toBe(true);
    });
  });
}
