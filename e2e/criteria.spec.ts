import { expect, test, type Page } from "@playwright/test";

import { DENSITIES, openCell, ROUTES, THEMES } from "./fixtures/matrix";

/**
 * The WCAG 2.2 AA criteria that no axe rule reaches, measured rather than asserted.
 *
 * Phase 7 established this list by measurement, not by reading the docs: every route was
 * scanned and the criteria axe actually reported on were collected. Axe covers contrast
 * for text (1.4.3), names, roles, labels, target size (2.5.8), reflow's viewport meta
 * (1.4.4) and inline spacing (1.4.12) - and it maps no rule at all to the criteria below.
 * Two of them are ones this design system makes explicit written claims about, which is
 * why leaving them to a manual checklist would have been the wrong call rather than the
 * convenient one.
 *
 *   1.4.11 Non-text contrast    - "3:1 for UI borders" is stated in styles.css, and the
 *                                 gate had never measured a border. It found the selected
 *                                 state at 1.02:1 in dark mode, on every control that
 *                                 marks a choice.
 *   1.4.10 Reflow               - the sweep asserted no horizontal scroll at 1366px, which
 *                                 is a desktop width and not the criterion's.
 *   2.4.11 Focus not obscured   - new in 2.2, and this app has a sticky header.
 *   2.3.3  Reduced motion       - AAA, and nothing in the stylesheet responded to it.
 *
 * What this file is not: a conformance claim. It measures four properties on a handful of
 * surfaces. The criteria that genuinely need a person - screen reader behaviour, real
 * colour vision, logical focus order, whether a label is understandable - are listed in
 * the design canvas as a manual checklist and are not covered by anything here.
 */

/**
 * Colour reading, shared by every probe below.
 *
 * Kept as a string because Playwright serialises it into the page, so it cannot close
 * over anything in this file. Two defects are baked out of it, both found the hard way:
 *
 *   - `fillStyle` is specified to *ignore* an assignment it cannot parse, so an
 *     unreadable colour silently becomes the previous one and the caller gets a confident
 *     number for something that was never measured. A sentinel is assigned first to make
 *     a parse failure detectable. The same defect was found and fixed in `states.spec.ts`.
 *   - A `box-shadow` layer is `"<colour> <x> <y> <blur> <spread>"`, so stripping a leading
 *     keyword with a regex eats the `oklch` in `oklch(0.6 0.008 250)` and leaves
 *     `(0.6 0.008 250) 0px 0px 0px 1px`. The first version of this file did exactly that,
 *     found no ring anywhere, fell back to comparing the fill, and reported the old
 *     1.09:1 - indistinguishable from the bug it was written to detect.
 */
const COLOUR_HELPERS = `
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const SENTINEL = "#010203";
  const toRgb = (css) => {
    if (!css) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = SENTINEL;
    ctx.fillStyle = css;
    if (ctx.fillStyle === SENTINEL && String(css).trim().toLowerCase() !== SENTINEL) return null;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const inParens = (s) =>
    /(rgba?|oklch|oklab|hsla?|lab|lch|color)\\([^)]*\\)|#[0-9a-fA-F]{3,8}/.exec(s)?.[0] ?? null;
  const over = (s, d) => [
    s[0] * s[3] + d[0] * d[3] * (1 - s[3]),
    s[1] * s[3] + d[1] * d[3] * (1 - s[3]),
    s[2] * s[3] + d[2] * d[3] * (1 - s[3]),
    s[3] + d[3] * (1 - s[3]),
  ];
  const lum = (c) => {
    const lin = (v) => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
  };
  const pageColour = () => {
    const c = toRgb(getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
    return c ? [c[0], c[1], c[2]] : [255, 255, 255];
  };
  /** The first painted colour behind an element, compositing translucent ancestors. */
  const behind = (el) => {
    const chain = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      const c = toRgb(getComputedStyle(node).backgroundColor);
      if (c) chain.push(c);
    }
    const [r, g, b] = pageColour();
    let acc = [r, g, b, 1];
    for (const c of chain.reverse()) acc = over(c, acc);
    return [acc[0], acc[1], acc[2]];
  };
  /**
   * The colours an element paints on its own boundary, in the order they are stacked.
   *
   * Outline first, then box-shadow layers, then a real border, then the fill. Tailwind
   * composes box-shadow as offset-shadow, ring-shadow, shadow, and the offset layer is
   * transparent, so with a plain ring the first opaque layer is the ring; a ring WITH an
   * offset puts an opaque offset band in front of it, which is why callers pick a marker by
   * contrast rather than by position.
   */
  const markerColours = (el) => {
    const s = getComputedStyle(el);
    const out = [];
    if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1) {
      const c = toRgb(s.outlineColor);
      if (c && c[3] >= 0.3) out.push({ rgba: c, via: "outline" });
    }
    if (s.boxShadow && s.boxShadow !== "none") {
      for (const layer of s.boxShadow.split(/,(?![^(]*\\))/)) {
        const c = toRgb(inParens(layer));
        if (c && c[3] >= 0.3) out.push({ rgba: c, via: "ring" });
      }
    }
    if (s.borderTopStyle !== "none" && parseFloat(s.borderTopWidth) >= 1) {
      const c = toRgb(s.borderTopColor);
      if (c && c[3] >= 0.3) out.push({ rgba: c, via: "border" });
    }
    const fill = toRgb(s.backgroundColor);
    if (fill && fill[3] >= 0.3) out.push({ rgba: fill, via: "fill" });
    return out;
  };

  /**
   * Contrast of a marker AS PAINTED, not as declared.
   *
   * A translucent marker is composited against what is behind it before being compared,
   * because that is the colour a person sees. Skipping this overstates translucent rings and
   * borders: the old 70%-alpha focus ring measured 5.5:1 as declared and about 3.1:1 as
   * painted.
   */
  const asPainted = (rgba, bg) => {
    const c = over(rgba, [bg[0], bg[1], bg[2], 1]);
    return ratio([c[0], c[1], c[2]], bg);
  };

  const describe = (el) =>
    (el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 24) || el.tagName.toLowerCase())
      .replace(/\\s+/g, " ");
`;

interface Control {
  who: string;
  via: string;
  ratio: number;
}

const MEASURE_CONTROLS = `
  (() => {
    ${COLOUR_HELPERS}
    const visible = (el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0;

    /**
     * Controls whose *state* is what identifies them.
     *
     * A plain text button is deliberately absent: its own label identifies it, which is
     * the exemption 1.4.11 carries. What is in scope is a control drawn the same as its
     * neighbour and distinguished only by a fill - a segmented control, a tab, a filter.
     * Those are the places where losing the boundary loses the state.
     */
    const selected = (el) =>
      el.getAttribute("aria-pressed") === "true" ||
      el.getAttribute("aria-selected") === "true" ||
      el.getAttribute("data-state") === "active" ||
      el.getAttribute("data-active") === "true";
    /** A control that must have a perceivable boundary: inputs, selects, switches. */
    const edgedControl = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") {
        return el.getAttribute("type") !== "hidden";
      }
      return ["switch", "checkbox", "combobox", "radio", "slider"].includes(el.getAttribute("role") ?? "");
    };

    const out = { selected: [], edged: [], controlCount: 0 };

    for (const el of document.querySelectorAll(
      'button, [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], input, select, textarea',
    )) {
      if (!visible(el)) continue;

      if (selected(el)) {
        out.controlCount += 1;
        const container = behind(el);
        // The selected state is whatever the reader can actually see distinguish it: the
        // highest-contrast boundary or fill the control paints. Picking by position would
        // read a white ring-offset band ahead of the ring that follows it.
        const candidates = markerColours(el).filter((m) => m.via !== "outline");
        const scored = candidates
          .map((m) => ({ via: m.via, ratio: asPainted(m.rgba, container) }))
          .sort((a, b) => b.ratio - a.ratio);
        if (scored[0]) out.selected.push({ who: describe(el), via: scored[0].via, ratio: scored[0].ratio });
      }

      if (edgedControl(el)) {
        out.controlCount += 1;
        // Not by contrast here: the border IS the control's boundary, and a background
        // fill must not be allowed to rescue a border that cannot be seen.
        const border = markerColours(el).find((m) => m.via === "border");
        if (border) {
          const bg = behind(el);
          out.edged.push({ who: describe(el), ratio: asPainted(border.rgba, bg) });
        }
      }
    }
    return out;
  })()
`;

const MEASURE_ACTIVE = `
  (() => {
    ${COLOUR_HELPERS}
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.offsetParent === null) return null;

    const header = document.querySelector("header");
    const headerStyle = header ? getComputedStyle(header) : null;
    const isSticky = headerStyle && (headerStyle.position === "sticky" || headerStyle.position === "fixed");
    const r = el.getBoundingClientRect();
    const h = header && isSticky ? header.getBoundingClientRect() : null;

    /**
     * 2.4.11 asks that a focused component is not *entirely* hidden. Partial occlusion is
     * permitted at AA, so that - not full visibility - is the bar. Elements that live
     * inside the sticky header are excluded: the header cannot obscure its own contents,
     * and counting them turned every header link into a false failure the first time this
     * ran.
     */
    const insideHeader = !!(header && header.contains(el));
    const swallowed =
      !!h && !insideHeader &&
      r.width > 0 && r.height > 0 &&
      r.top >= h.top - 1 && r.bottom <= h.bottom + 1 &&
      r.left >= h.left - 1 && r.right <= h.right + 1;

    // The indicator is whatever is painted on the boundary: an outline, else a box-shadow.
    // Scored by contrast rather than by position, because Tailwind puts an opaque offset
    // band in front of the ring whenever a component uses a ring-offset utility.
    const bg = behind(el);
    const rings = markerColours(el)
      .filter((m) => m.via === "outline" || m.via === "ring")
      .map((m) => ({ via: m.via, ratio: asPainted(m.rgba, bg) }))
      .sort((a, b) => b.ratio - a.ratio);

    /**
     * A stable per-element id. Comparing descriptions to detect the wrap back to the first
     * focus stop breaks on any page with two identically-labelled buttons - there are
     * several "Remove" and "Move up" controls - and would have silently cut the walk short.
     */
    if (!el.dataset.probeId) {
      window.__probeSeq = (window.__probeSeq || 0) + 1;
      el.dataset.probeId = String(window.__probeSeq);
    }

    return {
      id: el.dataset.probeId,
      who: describe(el),
      insideHeader,
      swallowed,
      rings,
    };
  })()
`;

interface Measure {
  selected: Control[];
  edged: Control[];
  controlCount: number;
}

interface FocusStop {
  id: string;
  who: string;
  insideHeader: boolean;
  swallowed: boolean;
  rings: Control[];
}

const measureControls = (page: Page) => page.evaluate(MEASURE_CONTROLS) as Promise<Measure>;

/**
 * Walk real keyboard focus order, one Tab at a time.
 *
 * Not `.focus()` in a loop: `:focus-visible` does not match on programmatic focus for a
 * button, so every ring in the app would have gone unmeasured while the test still
 * reported a number for the element's ordinary background. Tabbing is also the only way
 * to see 2.4.11, because the browser scrolls a focused element into view and does not
 * know about sticky headers.
 */
async function tabThrough(page: Page, limit: number): Promise<FocusStop[]> {
  await page.evaluate(() => {
    // Plain JS only: this body is serialised and run in the page, so a TypeScript type
    // assertion here is a runtime SyntaxError, not a compile error.
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    document.body.tabIndex = -1;
    document.body.focus();
  });

  const stops: FocusStop[] = [];
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    // Let any colour transition on the focused element finish. Without this the ring is
    // measured on its first painted frame, which for a `transition-colors` element is the
    // colour it is interpolating FROM. That is how the active nav pill first read 1.01:1.
    await page.evaluate(async () => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return;
      const running = el.getAnimations().filter((a) => a.playState === "running");
      if (running.length === 0) return;
      await Promise.race([
        Promise.all(running.map((a) => a.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    });
    const stop = (await page.evaluate(MEASURE_ACTIVE)) as FocusStop | null;
    if (!stop) continue;
    // Wrapping back to the first stop means focus order is exhausted.
    if (stops.length > 0 && stop.id === stops[0]!.id) break;
    stops.push(stop);
  }
  return stops;
}

const lines = (rows: Control[]) =>
  rows.map((r) => `${r.ratio}:1  ${r.who} (${r.via})`).join("\n  ");

test.describe("1.4.11 non-text contrast, which no axe rule covers", () => {
  test.describe.configure({ timeout: 600_000 });

  for (const theme of THEMES) {
    test(`every selected state and control edge clears 3:1 (${theme})`, async ({ page }) => {
      const failures: string[] = [];
      let selected = 0;
      let edged = 0;

      for (const route of ROUTES) {
        await openCell(page, route, { theme, density: "comfortable" });
        const result = await measureControls(page);
        selected += result.selected.length;
        edged += result.edged.length;
        const bad = [...result.selected, ...result.edged].filter((r) => r.ratio < 3);
        if (bad.length) failures.push(`${route}\n  ${lines(bad)}`);
      }

      // A sweep that measured nothing would pass. These counts are the guard against it.
      expect(selected, `no selected-state markers were measured in ${theme}`).toBeGreaterThan(10);
      expect(edged, `no control edges were measured in ${theme}`).toBeGreaterThan(5);
      expect(failures, `non-text contrast under 3:1\n${failures.join("\n")}`).toEqual([]);
      console.log(
        `[1.4.11 ${theme}] ${selected} selected markers, ${edged} control edges, all >= 3:1`,
      );
    });

    test(`every focus indicator clears 3:1 across real focus order (${theme})`, async ({
      page,
    }) => {
      const failures: string[] = [];
      let measured = 0;
      let stops = 0;

      for (const route of ROUTES) {
        await openCell(page, route, { theme, density: "comfortable" });
        const walked = await tabThrough(page, 45);
        stops += walked.length;
        const bad = walked
          .filter((s) => s.rings.length > 0)
          .map((s) => ({ who: s.who, via: s.rings[0]!.via, ratio: s.rings[0]!.ratio }))
          .filter((r) => r.ratio < 3);
        measured += walked.filter((s) => s.rings.length > 0).length;
        if (bad.length) failures.push(`${route}\n  ${lines(bad)}`);
      }

      expect(stops, `no focus stops were visited in ${theme}`).toBeGreaterThan(50);
      expect(measured, `no focus indicators were measured in ${theme}`).toBeGreaterThan(20);
      expect(failures, `focus indicators under 3:1\n${failures.join("\n")}`).toEqual([]);
      console.log(
        `[1.4.11 focus ${theme}] ${measured} indicators across ${stops} focus stops, all >= 3:1`,
      );
    });
  }
});

test.describe("1.4.10 reflow", () => {
  test.describe.configure({ timeout: 600_000 });

  /**
   * 320 CSS pixels is the criterion's width: a 1280px viewport at 400% zoom. The matrix's
   * 1366px check is a desktop width and does not exercise this, which is why the sweep
   * passing told us nothing about reflow.
   *
   * The assertion is about the *page*, not about every table. Content that legitimately
   * needs two dimensions - a wide match table, a draw bracket - is allowed to scroll
   * inside its own region, and this app wraps those in scroll containers. What may not
   * happen is the document itself scrolling sideways, which would put the header and the
   * navigation off-screen.
   */
  for (const density of DENSITIES) {
    test(`no route scrolls the page sideways at 320px (${density})`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      const failures: string[] = [];

      for (const route of ROUTES) {
        await openCell(page, route, { theme: "light", density });
        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          const visible = doc.clientWidth;
          if (doc.scrollWidth <= visible + 1) return null;
          // Name what is sticking out, so a failure is actionable rather than a number.
          const culprits = [...document.querySelectorAll("*")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.right > visible + 1;
            })
            .slice(0, 3)
            .map((el) => {
              const cls =
                typeof el.className === "string"
                  ? el.className.split(/\s+/).slice(0, 3).join(".")
                  : "";
              return `<${el.tagName.toLowerCase()}${cls ? "." + cls : ""}>`;
            });
          return { scrolled: doc.scrollWidth, visible, culprits };
        });
        if (overflow) {
          failures.push(
            `${route}: document is ${overflow.scrolled}px in a ${overflow.visible}px viewport; ` +
              `widest: ${overflow.culprits.join(", ")}`,
          );
        }
      }
      expect(failures, `page-level horizontal scroll at 320px`).toEqual([]);
    });
  }
});

test.describe("2.4.11 focus not obscured, new in WCAG 2.2", () => {
  test.describe.configure({ timeout: 600_000 });

  /**
   * The minimum level asks only that a focused component is not *entirely* hidden, and
   * this app has a sticky header - exactly the case the criterion was written for. The bar
   * is deliberately the criterion's bar and not a stricter one: asserting more than the
   * requirement would make this a test of the design rather than of conformance.
   */
  for (const theme of THEMES) {
    test(`no focused control is entirely hidden by the sticky header (${theme})`, async ({
      page,
    }) => {
      const failures: string[] = [];
      const perRoute: number[] = [];

      for (const route of ROUTES) {
        await openCell(page, route, { theme, density: "comfortable" });
        const walked = await tabThrough(page, 45);
        const relevant = walked.filter((s) => !s.insideHeader);
        perRoute.push(relevant.length);
        const hidden = relevant.filter((s) => s.swallowed).map((s) => s.who);
        if (hidden.length) failures.push(`${route}: ${hidden.join(", ")}`);
      }

      // A guard against a walk that silently visited nothing. Deliberately a total and not a
      // per-route minimum: /draws, /setup, /pools and /schedule render no focusable control
      // outside the header, so demanding one from every route would invent a requirement
      // rather than measure the criterion.
      const total = perRoute.reduce((a, b) => a + b, 0);
      expect(total, `focus stops per route: ${perRoute.join(", ")}`).toBeGreaterThan(ROUTES.length);
      expect(failures, `focused controls entirely hidden by the header`).toEqual([]);
      console.log(
        `[2.4.11 ${theme}] ${total} focus stops outside the header (per route: ${perRoute.join(", ")})`,
      );
    });
  }
});

test.describe("2.3.3 reduced motion", () => {
  /**
   * AAA, so this is not part of what AA requires and is recorded as such rather than
   * presented as a conformance result. It is here because nothing in the stylesheet
   * responded to the preference before this phase, and this check is what keeps the new
   * rule from being deleted by someone who does not know what it was for.
   */
  for (const theme of THEMES) {
    test(`a reduced-motion preference actually reduces motion (${theme})`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openCell(page, "/", { theme, density: "compact" });

      const durations = await page.evaluate(() => {
        const out: number[] = [];
        for (const el of document.querySelectorAll("button, div, li, tr, span")) {
          const s = getComputedStyle(el);
          for (const v of [s.transitionDuration, s.animationDuration]) {
            for (const part of v.split(",")) {
              const t = part.trim();
              const n = t.endsWith("ms")
                ? parseFloat(t)
                : t.endsWith("s")
                  ? parseFloat(t) * 1000
                  : 0;
              if (n > 0) out.push(n);
            }
          }
        }
        return out;
      });

      expect(durations.length, "no animated elements were found to check").toBeGreaterThan(10);
      const slowest = Math.max(...durations);
      expect(
        slowest,
        `the slowest transition or animation is still ${slowest}ms under reduced motion`,
      ).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("2.5.7 dragging movements, new in WCAG 2.2", () => {
  /**
   * Placement is the one surface that uses drag and drop, and the criterion allows it as
   * long as the same movement is possible without dragging.
   *
   * Both affordances are rendered under the same gate - `canReorder`, which is
   * `canEdit && seedsLocked && !hasMatches` - and the non-drag alternative is two buttons per
   * row labelled "Move <name> up one seed" and "Move <name> down one seed". The invariant
   * holds structurally, because a row cannot be draggable without also carrying the buttons.
   * What this test adds is a check that survives a later refactor moving one of them out of
   * that gate.
   */
  test("every draggable row keeps a non-drag alternative", async ({ page }) => {
    await openCell(page, "/placement", { theme: "light", density: "comfortable" });

    const result = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('tr[draggable="true"]')];
      return {
        draggable: rows.length,
        withoutAlternative: rows.filter(
          (row) => row.querySelectorAll("button[aria-label]").length < 2,
        ).length,
      };
    });

    if (result.draggable === 0) {
      // The skip is the point rather than an inconvenience. `canEdit` is false for an
      // unauthenticated visitor, so no draggable row is rendered against the seeded
      // environment and there is nothing to inspect - the same blocker as the four
      // staff-only Playwright tests. Recorded as unverified, not reported as a pass.
      test.skip(
        true,
        "/placement rendered no draggable rows because canEdit is false without an authenticated " +
          "session. Needs an authenticated staff session to exercise; unverified until then.",
      );
      return;
    }
    expect(
      result.withoutAlternative,
      `${result.withoutAlternative} of ${result.draggable} draggable rows offer no non-drag alternative`,
    ).toBe(0);
  });
});
