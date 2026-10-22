import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";

import { WCAG_TAGS } from "./matrix";

/**
 * The page probes the route sweep runs, kept out of the specs that used to own them.
 *
 * They lived in `criteria.spec.ts` (colour, controls, focus walk) and `matrix.spec.ts`
 * (axe contrast pairs, layout). Each of those specs reopened every route to run its own
 * probe, so the same page was loaded eight times per run. The probes are unchanged; only
 * where they are called from moved, so `route-sweep.spec.ts` can take every measurement
 * from one load of each route.
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
export const COLOUR_HELPERS = `
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
    // A rule on the bottom edge only, which is how a tab row marks the open section.
    if (s.borderBottomStyle !== "none" && parseFloat(s.borderBottomWidth) >= 1) {
      const c = toRgb(s.borderBottomColor);
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

export interface Control {
  who: string;
  via: string;
  ratio: number;
}

export const MEASURE_CONTROLS = `
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
     *
     * aria-current joins the list because it is how this app marks the other state of that
     * kind: an active section link, which TanStack's Link gives aria-current="page" without
     * us writing it. It was outside the sweep for the structural reason below rather than
     * because anyone judged it exempt - a link is not a button, and the selector named tags.
     * The setup wizard's current step (aria-current="step") is the third marker; it is in
     * the node set now, but the wizard is editor-gated so this sweep, which runs signed out,
     * still does not render it. That gap is named in the S13 (6 of 7) record row rather than
     * papered over here: the fix for the wizard was found by driving it, not by this.
     */
    const selected = (el) =>
      el.getAttribute("aria-pressed") === "true" ||
      el.getAttribute("aria-selected") === "true" ||
      (el.hasAttribute("aria-current") && el.getAttribute("aria-current") !== "false") ||
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
      'button, [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], input, select, textarea, [aria-current]',
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

    // Any indicator at all, by the plainer test the focus-visibility check has always used:
    // an outline with width, or a box-shadow. Weaker than the rings above, which also needs the
    // colour to be opaque enough to measure, so a stop can be visible and have no ring.
    const style = getComputedStyle(el);
    const visible =
      (style.outlineStyle !== "none" && (parseFloat(style.outlineWidth) || 0) > 0) ||
      (style.boxShadow !== "none" && style.boxShadow !== "");

    return {
      id: el.dataset.probeId,
      who: describe(el),
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().slice(0, 70),
      visible,
      insideHeader,
      swallowed,
      rings,
    };
  })()
`;

export interface Measure {
  selected: Control[];
  edged: Control[];
  controlCount: number;
}

export interface FocusStop {
  id: string;
  who: string;
  tag: string;
  cls: string;
  visible: boolean;
  insideHeader: boolean;
  swallowed: boolean;
  rings: Control[];
}

export const measureControls = (page: Page) => page.evaluate(MEASURE_CONTROLS) as Promise<Measure>;

/**
 * Walk real keyboard focus order, one Tab at a time.
 *
 * Not `.focus()` in a loop: `:focus-visible` does not match on programmatic focus for a
 * button, so every ring in the app would have gone unmeasured while the test still
 * reported a number for the element's ordinary background. Tabbing is also the only way
 * to see 2.4.11, because the browser scrolls a focused element into view and does not
 * know about sticky headers.
 */
export async function tabThrough(page: Page, limit: number): Promise<FocusStop[]> {
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
    // Landing on a stop already visited means focus order is exhausted. That is the wrap
    // back to the first stop, but also a last stop that Tab cannot leave (the sign-in page
    // ends on a link), which would otherwise be counted again on every remaining press.
    if (stops.some((seen) => seen.id === stop.id)) break;
    stops.push(stop);
  }
  return stops;
}

export const lines = (rows: Control[]) =>
  rows.map((r) => `${r.ratio}:1  ${r.who} (${r.via})`).join("\n  ");

/**
 * Every pair axe can resolve, not just the failing ones.
 *
 * Reading `passes` as well as `violations` is the whole point: a violation list answers
 * "is anything broken", while the passing nodes answer "how close is anything to
 * breaking". The distinction found a real fact about this system - the tightest pair it
 * can produce is 4.6:1 against a 4.5:1 requirement, a margin of 0.1, on the translucent
 * primary chip. It passes, but it passes by 0.1, and nothing would have reported that
 * until it stopped passing.
 */
export const MIN_MARGIN = 0.05;

export type Pair = { ratio: number; required: number; margin: number; where: string };

export type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

/** One axe run per page, shared by the baseline check and the contrast headroom check. */
export const runAxe = (page: Page): Promise<AxeResults> =>
  new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

export function contrastPairs(results: AxeResults): Pair[] {
  const rule = [...results.passes, ...results.violations].find((r) => r.id === "color-contrast");
  if (!rule) return [];

  const pairs: Pair[] = [];
  for (const node of rule.nodes) {
    for (const check of [...node.any, ...node.all]) {
      const data = check.data as Record<string, unknown>;
      const ratio = Number(data["contrastRatio"]);
      if (!Number.isFinite(ratio)) continue;
      const required = parseFloat(String(data["expectedContrastRatio"] ?? "4.5"));
      pairs.push({
        ratio,
        required,
        margin: Number((ratio - required).toFixed(2)),
        where: `${node.target.join(" ").slice(0, 70)} (${String(data["fgColor"])} on ${String(data["bgColor"])})`,
      });
    }
  }
  return pairs;
}

export type LayoutReport = {
  overflow: number;
  clipped: { tag: string; text: string; cls: string; overflow: number }[];
  geometry: { tag: string; x: number; y: number; w: number; h: number }[];
};

/**
 * Wait until the landmark set stops changing.
 *
 * `openCell` waits for network idle, but these routes render their tables from React
 * Query, and a query that resolves just after the network goes quiet adds a landmark on
 * the next paint. Measuring across two separate page loads then compares a settled page
 * against an unsettled one and reports drift that is not there.
 *
 * That is exactly what happened to `/draws` and `/` when the whole suite ran on four
 * workers: "measured no landmarks - expected 3, received 4". Both passed when the same
 * tests ran alone, which is the signature of a race rather than a defect, and a gate that
 * fails for a timing reason is a gate nobody will trust.
 *
 * Polling until the count repeats is the honest fix. It removes the race without
 * weakening the assertion: a page whose landmark set genuinely differs from its settled
 * state still fails, because every measurement is now taken in the same settled state.
 *
 * The count is stashed on `window`, which each `openCell` resets by navigating, so the
 * stability counter cannot leak from one measurement into the next.
 */
async function settleLandmarks(page: Page): Promise<void> {
  const LANDMARKS = "header, main, h1, h2, table";
  await page.waitForFunction(
    (selector) => {
      const count = document.querySelectorAll(selector).length;
      const w = window as unknown as { __landmarks?: { count: number; stable: number } };
      const previous = w.__landmarks;
      w.__landmarks =
        previous && previous.count === count
          ? { count, stable: previous.stable + 1 }
          : { count, stable: 0 };
      // Three consecutive identical readings, 100ms apart.
      return w.__landmarks.stable >= 2;
    },
    LANDMARKS,
    { timeout: 15_000, polling: 100 },
  );
}

/**
 * Measures three things in one pass: whether the page scrolls sideways, whether text is
 * silently cut off, and the geometry of the landmarks.
 *
 * The clipped-text rule is careful about intent. Visible truncation - `text-overflow:
 * ellipsis` - is a deliberate affordance and is excluded, because the reader is told the
 * value is abbreviated. What is reported is an element whose own text is wider than its
 * box while `overflow` is hidden or clipped and no ellipsis is offered: the value is then
 * simply gone, with nothing on screen to say so.
 */
export async function measureLayout(page: Page): Promise<LayoutReport> {
  await settleLandmarks(page);
  return page.evaluate(() => {
    const doc = document.documentElement;

    const clipped: LayoutReport["clipped"] = [];
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const style = getComputedStyle(element);
      if (style.overflowX !== "hidden" && style.overflowX !== "clip") continue;
      if (style.textOverflow === "ellipsis") continue;
      // Visually-hidden text is clipped on purpose and still read aloud, so it is not "gone".
      if (element.classList.contains("sr-only")) continue;
      const own = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      if (!own) continue;
      const overflow = element.scrollWidth - element.clientWidth;
      if (overflow > 1) {
        clipped.push({
          tag: element.tagName.toLowerCase(),
          text: own.slice(0, 40),
          cls: element.className?.toString().slice(0, 60) ?? "",
          overflow,
        });
      }
    }

    const geometry: LayoutReport["geometry"] = [];
    for (const element of Array.from(document.querySelectorAll("header, main, h1, h2, table"))) {
      const box = element.getBoundingClientRect();
      geometry.push({
        tag: `${element.tagName.toLowerCase()}${element.className ? "" : ""}`,
        x: Math.round(box.x * 10) / 10,
        y: Math.round(box.y * 10) / 10,
        w: Math.round(box.width * 10) / 10,
        h: Math.round(box.height * 10) / 10,
      });
    }

    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      clipped,
      geometry,
    };
  });
}
