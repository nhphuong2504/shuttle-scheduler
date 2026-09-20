import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
import { installDeskMock } from "./fixtures/desk-mock";
import { MATRIX_CELLS, WCAG_TAGS, cellLabel, openCell } from "./fixtures/matrix";

/**
 * Phase 6: every state and every urgency treatment, through the rendered app.
 *
 * ## What this file is for
 *
 * Phase 5 gave `void` a treatment and routed byes to a marker, and proved both in
 * jsdom. What jsdom cannot show is whether they resolve - whether the tokens a
 * component names produce a colour in a real cascade, in both themes, at both
 * densities, against a court tile that is itself tinted. A class name that exists and
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
 * Match statuses are only partly reachable here. `/placement-schedule` renders
 * without a session and is where the status vocabulary is swept, but its running
 * order excludes `void` by design - a void match never played, so it is not part of
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

/** The state vocabulary as the aria-label spells it: hyphens replaced by spaces. */
const ariaState = (state: CourtState) => state.replace("-", " ");

interface Chips {
  state: string;
  label: string | null;
  fill: Rgb;
  ink: Rgb;
  tileBorder: Rgb;
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
 */
async function readCourtChips(page: Page): Promise<Chips[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await readCourtChipsOnce(page);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(DETACHED)) throw error;
    }
  }
  throw new Error("the court board re-rendered on every attempt to measure it");
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
    // stylesheet paints the page with, so reading it keeps this honest in dark mode
    // rather than assuming white.
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
    test("every court state renders, with its own label and its own fill", async ({ page }) => {
      await installDeskMock(page, "states");
      await openCell(page, "/", cell);

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
      expect(
        edges.get("free-blocked"),
        `waiting ${edges.get("free-blocked")} vs idle ${edges.get("idle")} - the two ` +
          `states that ask for nothing are supposed to share the resting hairline`,
      ).toBe(edges.get("idle"));
      const actionable = COURT_STATES.filter(
        (state) => state !== "free-blocked" && state !== "idle",
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
      await installDeskMock(page, "states");
      await openCell(page, "/", cell);

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

    test("the four urgency treatments all render and separate", async ({ page }) => {
      await installDeskMock(page, "states");
      await openCell(page, "/", cell);

      const report = await page.evaluate(() => {
        const live = document.querySelector('[aria-live="polite"]');
        const text = (live?.textContent ?? "").replace(/\s+/g, " ");
        const items = live ? [...live.querySelectorAll("li")] : [];
        const surfaceOf = (needle: string) => {
          const item = items.find((li) => (li.textContent ?? "").includes(needle));
          if (!item) return null;
          // The tinted box is the <li> itself for the alerts and the inner button for
          // the dispatch prompt, so the first background that is not transparent wins.
          const candidates: Element[] = [item, ...item.querySelectorAll("*")];
          for (const el of candidates) {
            const bg = getComputedStyle(el).backgroundColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
          }
          return null;
        };
        return {
          allClear: text.includes("All clear"),
          // The primary dispatch prompt: the one action the desk wants taken.
          dispatch: text.includes("is free — start"),
          dispatchSurface: surfaceOf("is free — start"),
          // Two attention alerts, from different causes.
          unplaced: text.includes("ready with no court"),
          unplacedSurface: surfaceOf("ready with no court"),
          overrun: text.includes("has been on court"),
          overrunSurface: surfaceOf("has been on court"),
          // The destructive one: a result that is overdue.
          overdue: text.includes("past its scheduled finish"),
          overdueSurface: surfaceOf("past its scheduled finish"),
        };
      });

      expect(report.allClear, "the Act now panel fell back to its empty state").toBe(false);

      for (const [what, present] of [
        ["the primary dispatch prompt", report.dispatch],
        ["the unplaced-pairing alert", report.unplaced],
        ["the over-cap alert", report.overrun],
        ["the overdue-results alert", report.overdue],
      ] as const) {
        expect(present, `${what} did not render`).toBe(true);
      }

      // The surfaces must separate. A destructive alert that resolved to the same tint
      // as an advisory one would be a real operational defect.
      //
      // Four treatments, but three surfaces, and that is deliberate rather than a
      // collapse: both the unplaced-pairing alert and the over-cap alert are warnings,
      // and the design gives every warning one surface. What must not happen is a
      // warning looking like the primary action, or either looking like the destructive
      // overdue result. So the assertion is that exactly the expected set of surfaces
      // appears, stated as the relationship rather than as a count of distinct tints -
      // a count alone would pass if two warnings became two arbitrary new colours.
      for (const [what, surface] of [
        ["the primary dispatch prompt", report.dispatchSurface],
        ["the unplaced-pairing alert", report.unplacedSurface],
        ["the over-cap alert", report.overrunSurface],
        ["the overdue-results alert", report.overdueSurface],
      ] as const) {
        expect(surface, `${what} carries no measurable surface`).not.toBeNull();
      }
      expect(
        report.unplacedSurface,
        "a warning stopped sharing the warning surface with the other warning",
      ).toBe(report.overrunSurface);
      expect(report.dispatchSurface, "the primary action resolved to the warning surface").not.toBe(
        report.overrunSurface,
      );
      expect(
        report.overdueSurface,
        "the destructive overdue result resolved to the warning surface",
      ).not.toBe(report.overrunSurface);
      expect(
        report.overdueSurface,
        "the destructive overdue result resolved to the primary action's surface",
      ).not.toBe(report.dispatchSurface);
    });

    test("the state chips survive grayscale and deuteranopia", async ({ page }) => {
      await installDeskMock(page, "states");
      await openCell(page, "/", cell);

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
      await installDeskMock(page, "layout");
      await openCell(page, "/placement-schedule", cell);

      const pills = await page.evaluate(() =>
        [
          ...new Set(
            [...document.querySelectorAll("span")]
              .filter((el) => el.querySelector("svg") && (el.textContent ?? "").trim())
              .map((el) => el.textContent!.trim()),
          ),
        ].sort(),
      );

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
      await installDeskMock(page, "states");
      await openCell(page, "/", cell);

      const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
      const ids = results.violations.map((v) => v.id).sort();
      if (ids.length) console.log(`[${cellLabel(cell)}] desk violations: ${ids.join(", ")}`);
      expect(ids).toEqual([]);
    });

    test("a populated running order introduces no new a11y violation", async ({ page }) => {
      await installDeskMock(page, "layout");
      await openCell(page, "/placement-schedule", cell);

      const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
      const ids = results.violations.map((v) => v.id).sort();
      if (ids.length)
        console.log(`[${cellLabel(cell)}] running-order violations: ${ids.join(", ")}`);
      expect(ids).toEqual([]);
    });

    test("a court tile takes a visible focus ring", async ({ page }) => {
      // The focus sweep in `matrix.spec.ts` walks every route in every cell, but it
      // walks them empty. A ring can be clipped by the tile that contains it, so the
      // populated tile is the case worth stating separately.
      await installDeskMock(page, "states");
      await openCell(page, "/", cell);

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
