import { type Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { COURT_COUNT, LONGEST_PAIRING, WIDEST_SCORE } from "./fixtures/desk-mock";
import { routes } from "./fixtures/routes";

/**
 * P2 layout validation: does the type scale actually fit real content?
 *
 * ## What this adds that nothing else did
 *
 * The typography spec proves nothing renders below 12px, which is a statement about
 * *size*. This file is a statement about *fit*, and the two are not the same question. A
 * size can be perfectly legible and still be clipped, wrapped into an unreadable column,
 * or pushed under a neighbouring control - and none of those are visible to a font-size
 * measurement, because the text that got cut is not in the DOM any more.
 *
 * The live tournament cannot answer this. It has no courts, no teams and no matches, so
 * the desk has only ever rendered its empty state, and the empty state cannot overflow.
 * `./fixtures/desk-mock.ts` supplies hostile but legal content instead, in a real browser
 * against the real stylesheet, without writing to any database.
 *
 * ## Why these three viewports
 *
 * 1366x768 is the tightest laptop the app targets, where the fewest pixels have to carry
 * the most content and a four-column court grid has the least room per tile. 1920x1080 is
 * the common desk monitor. 2560x1440 is where the earlier phases were validated and where
 * a layout that merely "fits" at 1366 can look sparse but must not look broken.
 *
 * ## Two measurement traps this file has already fallen into
 *
 * Both are recorded because they are the reason the assertions look the way they do, and
 * both produced a suite that passed while the layout was wrong.
 *
 *   1. `scrollWidth` cannot see this bug at all. The score cell is right-aligned, and
 *      overflow to the *left* of a right-aligned box is not counted by `scrollWidth`, so
 *      the cell reported 96px of content in 96px of space while the value was visibly
 *      wider. Glyph widths are measured with a `Range` instead, which measures the text
 *      rather than the box's scrolling area.
 *   2. Fonts load asynchronously, and a fallback face has different metrics. An early run
 *      measured the smaller tier as *wider* than the larger one, which is impossible for a
 *      single font and was the tell. `document.fonts.ready` is awaited before anything is
 *      measured.
 *
 * A wrapped value is a third failure mode that neither of the above catches, because
 * wrapping is not overflow. It is asserted separately, by counting line boxes.
 */

const VIEWPORTS = [
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "2560x1440", width: 2560, height: 1440 },
] as const;

/** Awaits the web font, without which every width measurement is a guess. */
async function awaitFonts(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

interface TextBox {
  text: string;
  cellWidth: number;
  /** Width of the glyphs themselves, measured with a Range. */
  textWidth: number;
  /** How many lines the text occupies. More than one means it wrapped. */
  lineBoxes: number;
  fontSize: number;
  /** An ancestor that hides this element's edges, if any. */
  clippedByAncestor: string | null;
}

const PROBE = (args: { pairing: string; score: string }) => {
  const measure = (el: Element | null): TextBox | null => {
    if (!el) return null;
    const h = el as HTMLElement;
    const cell = h.getBoundingClientRect();

    const range = document.createRange();
    range.selectNodeContents(h);
    const rects = Array.from(range.getClientRects());
    const textWidth = rects.reduce((max, r) => Math.max(max, r.width), 0);

    let clippedByAncestor: string | null = null;
    let node = h.parentElement;
    while (node && node !== document.body) {
      const ns = getComputedStyle(node);
      if (ns.overflowX === "hidden" || ns.overflowX === "clip") {
        const parentBox = node.getBoundingClientRect();
        if (cell.right > parentBox.right + 1 || cell.left < parentBox.left - 1) {
          clippedByAncestor = `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}`;
          break;
        }
      }
      node = node.parentElement;
    }

    return {
      text: (h.textContent ?? "").trim(),
      cellWidth: Math.round(cell.width),
      textWidth: Math.round(textWidth),
      lineBoxes: rects.length,
      fontSize: parseFloat(getComputedStyle(h).fontSize),
      clippedByAncestor,
    };
  };

  /**
   * The score is its own element, so an exact match is unambiguous.
   */
  const scoreEl =
    Array.from(document.querySelectorAll("span")).find(
      (el) => (el.textContent ?? "").trim() === args.score,
    ) ?? null;

  /**
   * The pairing is not its own element - it shares a paragraph with a tag and a timer on
   * the court tile, and with "vs" between the two names in the score list - so an exact
   * match finds nothing and a loose one finds a wrapper too big to be meaningful. The
   * tightest element whose text contains it is the one that actually has to fit it.
   */
  const pairingEl =
    Array.from(document.querySelectorAll("main *"))
      .filter((el) => (el.textContent ?? "").includes(args.pairing))
      .sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length)[0] ?? null;

  let minFont = Infinity;
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (!el.textContent?.trim()) continue;
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3)) continue;
    minFont = Math.min(minFont, parseFloat(getComputedStyle(el).fontSize));
  }

  const overflows: { tag: string; cls: string; scrollW: number; clientW: number; text: string }[] =
    [];
  for (const el of Array.from(document.querySelectorAll("main *"))) {
    const h = el as HTMLElement;
    if (h.clientWidth > 0 && h.scrollWidth > h.clientWidth + 1) {
      overflows.push({
        tag: h.tagName.toLowerCase(),
        cls: String(h.className).slice(0, 60),
        scrollW: h.scrollWidth,
        clientW: h.clientWidth,
        text: (h.textContent ?? "").trim().slice(0, 50),
      });
    }
  }

  return {
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    minFont,
    overflows,
    tileCount: document.querySelectorAll('[aria-label^="Court "]').length,
    pairing: measure(pairingEl),
    score: measure(scoreEl),
    bodyHasPairing: document.body.innerText.includes(args.pairing),
    bodyHasScore: document.body.innerText.includes(args.score),
  };
};

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.beforeEach(async ({ page }) => {
      await installAppMock(page, { preset: "layout" });
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    test("the court board fits a long doubles pairing without clipping", async ({ page }) => {
      await page.goto(routes.desk, { waitUntil: "networkidle" });
      await awaitFonts(page);

      const r = await page.evaluate(PROBE, { pairing: LONGEST_PAIRING, score: WIDEST_SCORE });
      const where = vp.name;

      // The board is populated at all: an empty board would trivially "fit".
      expect(r.tileCount, `court tiles rendered at ${where}`).toBe(COURT_COUNT);

      expect(
        r.docScrollW,
        `horizontal page overflow at ${where}: ${r.docScrollW} > ${r.docClientW}`,
      ).toBeLessThanOrEqual(r.docClientW + 1);

      expect(r.minFont, `smallest rendered text at ${where}`).toBeGreaterThanOrEqual(12);

      // The hostile pairing is present, and the element that holds it was really found.
      expect(r.bodyHasPairing, `pairing rendered at ${where}`).toBe(true);
      expect(r.pairing, `pairing element located at ${where}`).not.toBeNull();
      expect(r.pairing!.clippedByAncestor, `pairing clipped at ${where}`).toBeNull();

      // A 65-character pairing is expected to wrap on a narrow tile; what it must not do
      // is overflow the element that contains it.
      expect(
        r.pairing!.textWidth,
        `pairing glyphs wider than their box at ${where}: ${r.pairing!.textWidth}px in ` +
          `${r.pairing!.cellWidth}px`,
      ).toBeLessThanOrEqual(r.pairing!.cellWidth + 1);

      expect(
        r.overflows,
        `overflowing elements at ${where}: ${JSON.stringify(r.overflows)}`,
      ).toEqual([]);
    });

    test("the score list keeps a three-game 30-29 score on one line", async ({ page }) => {
      await page.goto(routes.scores, { waitUntil: "networkidle" });
      await awaitFonts(page);

      // The knockout tab is unmounted until selected, and that is where the fixtures put
      // the reported matches whose scores are widest.
      await page.getByRole("tab", { name: /Knockout/ }).click();
      await page.waitForTimeout(300);

      const r = await page.evaluate(PROBE, { pairing: LONGEST_PAIRING, score: WIDEST_SCORE });
      const where = vp.name;

      expect(r.bodyHasScore, `widest score rendered at ${where}`).toBe(true);
      expect(r.score, `score element located at ${where}`).not.toBeNull();
      expect(r.docScrollW).toBeLessThanOrEqual(r.docClientW + 1);
      expect(r.minFont).toBeGreaterThanOrEqual(12);

      // The assertion this test exists for. A score is a number: splitting it across
      // lines can change what it reads as, so one line box is required, not preferred.
      expect(
        r.score!.lineBoxes,
        `score wrapped onto ${r.score!.lineBoxes} lines at ${where}: "${r.score!.text}"`,
      ).toBe(1);

      // And having been kept on one line, it must still fit the space it was given
      // rather than spilling over the control beside it.
      expect(
        r.score!.textWidth,
        `score glyphs wider than their cell at ${where}: ${r.score!.textWidth}px in ` +
          `${r.score!.cellWidth}px`,
      ).toBeLessThanOrEqual(r.score!.cellWidth + 1);
      expect(r.score!.clippedByAncestor, `score clipped at ${where}`).toBeNull();

      // The pairing must not be the element that gives way to make the score fit.
      expect(r.bodyHasPairing).toBe(true);
      expect(r.pairing).not.toBeNull();
      expect(r.pairing!.clippedByAncestor).toBeNull();
      expect(r.overflows).toEqual([]);
    });
  });
}
