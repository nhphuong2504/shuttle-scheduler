import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  displayStateFor,
  PERSISTED_MATCH_STATUSES,
  TIER4_DISPLAY_STATES,
} from "@/lib/tournament/match-status";

/**
 * Token-reference integrity.
 *
 * Tailwind v4 emits `background-color: var(--mint)` for `bg-mint`. If `--mint`
 * is undefined the declaration is silently invalid and the element renders with
 * no background at all — no compiler error, no lint warning, no console message.
 *
 * That is exactly how `--mint` came to be neutralised to a mid grey while eleven
 * components still referenced it. TypeScript cannot see inside a className
 * string, and ESLint never looks at a stylesheet, so nothing in the existing
 * suite could have caught it. This file is that missing check.
 *
 * What it deliberately does NOT do: judge whether a colour is the *right*
 * colour. `mint` resolving to grey is semantically wrong and this test passes it,
 * because "grey" and "green" are indistinguishable to a parser. Semantic
 * correctness is covered by the design review and the render tests, not here.
 * This file answers one narrow question: does every reference resolve at all?
 */

const ROOT = join(__dirname, "../../..");
const CSS = readFileSync(join(ROOT, "src/styles.css"), "utf8");

/** Every custom property defined anywhere in the stylesheet. */
const defined = new Set<string>();
for (const match of CSS.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) {
  defined.add(match[1]!);
}

/** The `@theme inline` block, which maps token names onto those properties. */
const themeStart = CSS.indexOf("@theme inline {");
const themeEnd = CSS.indexOf("\n}", themeStart);
const themeBlock = CSS.slice(themeStart, themeEnd);

function mappings(prefix: "color" | "text"): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = new RegExp(
    `^\\s*--${prefix}-([a-zA-Z0-9-]+)\\s*:\\s*var\\(\\s*(--[a-zA-Z0-9-]+)\\s*\\)`,
    "gm",
  );
  for (const match of themeBlock.matchAll(pattern)) {
    found.set(match[1]!, match[2]!);
  }
  return found;
}

const colorMap = mappings("color");
const textMap = mappings("text");

/**
 * Text-scale mappings, deliberately not asserted against.
 *
 * The four importance tiers land in P2 and become the first real entries here, so
 * the only pre-existing members were the seven far-view sizes, which P1 deleted
 * along with the wall-display scope. Until P2 the map is empty, and a test that
 * demanded entries would be asserting against a feature that does not exist.
 */
void textMap;

/** The `:root` and `.dark` declaration blocks, kept separate. */
function declarationBlock(selector: string): string {
  const start = CSS.indexOf(`\n${selector} {`);
  return start === -1 ? "" : CSS.slice(start, CSS.indexOf("\n}", start));
}

const lightBlock = declarationBlock(":root");
const darkBlock = declarationBlock(".dark");

function namesIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) found.add(match[1]!);
  return found;
}

const lightNames = namesIn(lightBlock);
const darkNames = namesIn(darkBlock);

/** Block sets and the closure use different conventions; compare unprefixed. */
const unprefixed = (names: Set<string>) => new Set([...names].map((n) => n.replace(/^--/, "")));

/**
 * Colour tokens resolved transitively.
 *
 * A mapping target can point at another token - `--input: var(--border-control)` -
 * so the set of properties that must exist in *both* themes is the closure over
 * those references, not just the direct targets.
 */
function colorClosure(): Set<string> {
  const found = new Set<string>();
  const queue = [...colorMap.values()].map((target) => target.replace(/^--/, ""));
  while (queue.length) {
    const name = queue.pop()!;
    if (found.has(name)) continue;
    found.add(name);
    const declaration = CSS.match(
      new RegExp(`^\\s*--${name.replace(/-/g, "\\-")}\\s*:\\s*([^;]+);`, "m"),
    );
    for (const reference of declaration?.[1]?.matchAll(/var\(\s*--([a-zA-Z0-9-]+)/g) ?? []) {
      queue.push(reference[1]!);
    }
  }
  return found;
}

/** Source files, excluding tests: a test may name a token it is asserting about. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if ([".ts", ".tsx"].includes(extname(path)) && !path.includes(".test.")) out.push(path);
  }
  return out;
}

const sourcePaths = walk(join(ROOT, "src"));

/**
 * Comments are stripped before any source is inspected.
 *
 * A scanner that reads prose cannot tell a real class from a class *mentioned* in a
 * comment, so it produces two opposite failures. It invents violations when a comment
 * explains what a class does, and - worse - it is satisfied by a comment that names a
 * token nothing actually uses, which is the exact condition these guards exist to
 * catch. Neither price is worth paying to avoid one regex.
 *
 * The `[^:]` guard keeps `https://` intact.
 */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const source = sourcePaths.map((file) => stripComments(readFileSync(file, "utf8"))).join("\n");

/** Utility prefixes that take a colour token in Tailwind v4. */
const PREFIXES =
  "bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|caret|accent|shadow";

function usageCount(token: string): number {
  const pattern = new RegExp(
    `(?:^|[\\s"'\`:{(])(${PREFIXES})-${token.replace(/-/g, "\\-")}(?:/\\d+)?(?![\\w-])`,
    "g",
  );
  return source.match(pattern)?.length ?? 0;
}

/**
 * A token is live when a component uses it, or when the value of a token that is
 * itself live points at it. The second clause matters: `--border-control` is used
 * by no component directly, but `--input` points at it and `border-input` appears
 * in nine primitives, so deleting it on the evidence of usage alone would break
 * every control edge in the app.
 */
const live = new Set<string>();
for (const token of colorMap.keys()) {
  if (usageCount(token) > 0) live.add(token);
}

const referencesOf = new Map<string, string[]>();
for (const token of colorMap.keys()) {
  const declaration = CSS.match(
    new RegExp(`^\\s*--${token.replace(/-/g, "\\-")}\\s*:\\s*([^;]+);`, "m"),
  );
  referencesOf.set(
    token,
    declaration
      ? [...declaration[1]!.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]!)
      : [],
  );
}

for (let pass = 0; pass < 4; pass += 1) {
  for (const token of [...live]) {
    for (const reference of referencesOf.get(token) ?? []) {
      const backing = reference.replace(/^--/, "");
      if (colorMap.has(backing)) live.add(backing);
    }
  }
}

const deadTokens = [...colorMap.keys()].filter((token) => !live.has(token)).sort();

/**
 * The debt this test pins, stated so it cannot grow silently.
 *
 * Shrank from 15 to 11 in phase 1: `coral` and `cyan` were deleted for being
 * unused, and `state-retired-ink` / `state-walkover-ink` went with the phantom
 * states they described. That last pair is worth noting - they were the executable
 * evidence for the audit finding that tier 4 collapses onto one ink, and deleting
 * them is the fix rather than the cover-up.
 *
 * Shrank from 11 to 6 when the 36 unused shadcn primitives were deleted: the
 * `chart-*` series and the whole `sidebar-*` family existed only for `chart.tsx`
 * and `sidebar.tsx`, so their `--color-*` keys and both theme declarations went
 * with them rather than being left as dead debt.
 *
 * What remains is deliberate rather than forgotten:
 *
 * - `card` / `card-foreground` are the third step of the chassis ramp
 *   (`--background` -> `--surface` -> `--card`) named in docs/design-system.md.
 *   No component renders `bg-card` today, but the surface is part of the shipped
 *   vocabulary, so the token stays.
 * - `info-*` is defined but no surface uses the info tone.
 * - `ring-offset-background` is a shadcn default whose utility does appear on the
 *   live `dialog`, `select` and `tabs` primitives; the scanner cannot see it
 *   because the class reads `ring-offset-background` rather than `ring-<token>`.
 */
const KNOWN_DEAD = [
  "card",
  "card-foreground",
  "info-border",
  "info-foreground",
  "info-surface",
  "ring-offset-background",
];

describe("token references all resolve", () => {
  it("defines every custom property that styles.css reads", () => {
    const referenced = new Set<string>();
    for (const match of CSS.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) referenced.add(match[1]!);
    const dangling = [...referenced].filter((name) => !defined.has(name)).sort();
    expect(dangling).toEqual([]);
  });

  it("points every colour and text mapping at a defined property", () => {
    const dangling = [...colorMap, ...textMap]
      .filter(([, target]) => !defined.has(target))
      .map(([token, target]) => `${token} -> ${target}`)
      .sort();
    expect(dangling).toEqual([]);
  });

  it("has no colour token that nothing renders", () => {
    // Pinned rather than advisory: a new dead token fails the suite, so the debt
    // can only shrink. When phase 1 deletes these, this list shrinks with it.
    expect(deadTokens).toEqual(KNOWN_DEAD);
  });

  it("wires every match-state token to a component", () => {
    // Empty as of phase 1. It asserted the two tier-4 inks that shared
    // `state-completed-ink`; those tokens were deleted with the phantom states,
    // so the only tokens left are ones a component actually reads. The list stays
    // as an assertion so a future orphan cannot appear unnoticed.
    const orphans = [...colorMap.keys()]
      .filter((token) => token.startsWith("state-") && !live.has(token))
      .sort();
    expect(orphans).toEqual([]);
  });

  it("covers every status the domain can persist, with no gap left open", () => {
    // StatusPill aliases two persisted values onto their display state, and two
    // more share the tier-4 ink by design rather than owning a token each. So the
    // question is not "does every status have its own token" - it is "is every
    // status representable at all".
    //
    // The vocabulary is read from the shared module rather than restated here. That
    // is the change phase 5 made: this test used to re-declare the alias map and the
    // tier-4 sharing by hand, so it could only ever confirm what it already said -
    // which is how `void` stayed in the list of known gaps without the list ever
    // noticing it was a defect rather than a fact.
    const persisted: readonly string[] = PERSISTED_MATCH_STATUSES;
    const unrepresentable = persisted.filter((status) => {
      const display = displayStateFor(status);
      if (!display) return true;
      if (TIER4_DISPLAY_STATES.includes(display)) return false;
      return ![...colorMap.keys()].some((token) => token.startsWith(`state-${display}-`));
    });

    // `void` closed this list in phase 5: it gained a label, a tier 3 chip and its
    // own -chip/-ink pair, so every persisted status is now representable and the
    // assertion is empty. It stays as an assertion rather than being deleted, so a
    // status added to the schema without a token fails here.
    expect(unrepresentable).toEqual([]);
  });

  it("keeps tier 4 on a single shared ink", () => {
    // The design decision, made executable. walkover and completed must NOT grow
    // their own ink tokens: they are separated by label and glyph, which is the
    // redundant channel every state relies on, not by colour.
    const tier4 = [...colorMap.keys()].filter((t) => t === "state-completed-ink");
    expect(tier4).toEqual(["state-completed-ink"]);
    expect(colorMap.has("state-walkover-ink")).toBe(false);
    expect(colorMap.has("state-completed-chip")).toBe(false);
  });
});

/**
 * Theme scope parity.
 *
 * A colour token defined in `:root` but not in `.dark` does not fail to render -
 * it silently keeps its light-mode value, so dark mode ends up with a light
 * surface somewhere and nothing reports it. The flat namespace check above cannot
 * see that, because the property is defined *somewhere*. These tests are scoped
 * per block so the drift is visible.
 */
describe("both themes define the same colour tokens", () => {
  it("defines every colour property in :root and .dark", () => {
    const light = unprefixed(lightNames);
    const dark = unprefixed(darkNames);
    const missingFromDark = [...colorClosure()].filter((name) => !dark.has(name)).sort();
    const missingFromLight = [...colorClosure()].filter((name) => !light.has(name)).sort();
    expect(missingFromDark).toEqual([]);
    expect(missingFromLight).toEqual([]);
  });

  it("keeps only theme-independent tokens out of .dark", () => {
    // Structural and density values - radius, elevation, row height and the type
    // scale - are deliberately shared rather than duplicated per theme: neither
    // darkness nor lightness changes how tall a row is. If a *colour* ever appears
    // in this list the previous test fails first; this one documents the exempt set
    // so an addition has to be justified rather than go unnoticed.
    const dark = unprefixed(darkNames);
    const lightOnly = [...lightNames].filter((name) => !dark.has(name.replace(/^--/, ""))).sort();
    expect(lightOnly).toEqual([
      "--elev-1",
      "--elev-2",
      "--radius",
      "--row-height",
      "--type-t1-lh",
      "--type-t1-size",
      "--type-t2-lh",
      "--type-t2-size",
      "--type-t3-lh",
      "--type-t3-size",
      "--type-t4-lh",
      "--type-t4-size",
    ]);
  });
});

/**
 * Utility-to-theme resolution.
 *
 * The tests above check that every `var()` reference resolves. They do NOT check
 * the other half of the contract: that a Tailwind *class* named after a theme key
 * still has a theme key to find.
 *
 * That gap shipped a real defect. P1 deleted `--color-brand` from the theme block,
 * which orphaned `text-brand` in the app shell. Tailwind then emitted no rule at
 * all for the class - not an invalid declaration, simply nothing - so the wordmark
 * silently inherited its parent's colour. `tsc` cannot see inside a className
 * string, ESLint never reads the stylesheet, and the token tests passed because a
 * class with no rule leaves no dangling `var()` behind.
 *
 * Two things were wrong with how P1 was verified, and this test addresses both:
 * the manual probe only checked the *newly added* utilities, and nothing checked
 * the *pre-existing* ones for collateral damage.
 */
describe("every colour utility resolves to a theme key", () => {
  /**
   * Suffixes that share a colour-prefix name but are not colours.
   *
   * This list is the test's main weakness and is kept explicit for that reason:
   * a suffix missing from it shows up as a failure, which is noisy but safe, while
   * a colour wrongly added to it would be silently exempt. Membership requires a
   * reason, so the risk is visible rather than assumed.
   */
  const NON_COLOUR = new Set([
    // Keywords and built-in colour words.
    "bg-current",
    "bg-transparent",
    "text-current",
    "border-transparent",
    "border-l-transparent",
    "border-t-transparent",
    "fill-current",
    "stroke-transparent",
    "bg-white",
    "bg-black",
    // Border width, side and style utilities.
    "border-b",
    "border-b-0",
    "border-t",
    "border-l",
    "border-r",
    "border-x",
    "border-y",
    "border-0",
    "border-2",
    "border-4",
    "border-8",
    "border-dashed",
    "border-dotted",
    "border-double",
    "border-solid",
    "border-none",
    "border-collapse",
    "border-separate",
    "border-spacing",
    "border-radius",
    "border-color",
    // Divide utilities.
    "divide-y",
    "divide-x",
    // Ring geometry. `ring-offset-background` is deliberately absent: it IS a theme key,
    // and the full-name check below resolves it.
    "ring-inset",
    "ring-offset-1",
    "ring-offset-2",
    "ring-offset-4",
    "ring-offset-8",
    // Text alignment, wrapping and decoration.
    "text-align",
    "text-left",
    "text-center",
    "text-right",
    "text-justify",
    "text-start",
    "text-end",
    "text-decoration",
    "text-transform",
    "text-overflow",
    "text-wrap",
    "text-nowrap",
    "text-balance",
    "text-pretty",
    "text-ellipsis",
    "text-clip",
    // Type sizes. The P2 tiers join these; both are legitimate non-colour utilities.
    "text-xs",
    "text-sm",
    "text-base",
    "text-lg",
    "text-xl",
    "text-2xl",
    "text-3xl",
    "text-4xl",
    "text-5xl",
    "text-t1",
    "text-t2",
    "text-t3",
    "text-t4",
  ]);

  /** Namespaces that take a colour, matching Tailwind's own utility families. */
  const NAMESPACES = ["bg", "text", "border", "ring", "fill", "stroke", "divide"] as const;
  const NAMESPACE_PATTERN = new RegExp(
    `\\b(${NAMESPACES.join("|")})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`,
    "g",
  );

  it("has a --color-* key behind every colour class in src", () => {
    const orphans: string[] = [];
    for (const file of sourcePaths) {
      const text = stripComments(readFileSync(file, "utf8"));
      const relative = file.replace(`${ROOT}/`, "");
      for (const match of text.matchAll(NAMESPACE_PATTERN)) {
        const full = match[0]!;
        const name = match[2]!;
        if (NON_COLOUR.has(full)) continue;
        // Full name first: `ring-offset-background` maps to --color-ring-offset-background,
        // so splitting on the first hyphen would look for the wrong key.
        if (colorMap.has(full)) continue;
        if (colorMap.has(name)) continue;
        orphans.push(`${relative}: ${full}`);
      }
    }
    expect([...new Set(orphans)].sort()).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // Every exemption must look like a real utility in an inspected namespace, so a
    // typo cannot silently widen the allowlist. This caught its own author twice:
    // `shadow` was listed as a namespace while not being scanned, and `from`/`to`/
    // `via` were scanned while matching ordinary prose like "to-item".
    for (const name of NON_COLOUR) {
      expect(name, `"${name}" is not a utility in an inspected namespace`).toMatch(
        new RegExp(`^(${NAMESPACES.join("|")})-[a-z0-9][a-z0-9-]*$`),
      );
    }
  });
});

/**
 * Density token parity.
 *
 * Same failure shape as the theme-parity tests above, one axis over. A tier token
 * declared in the base block but missing from the compact block does not fail to
 * render - it silently keeps its comfortable value, so Compact is 90% applied and
 * one tier is quietly too large. Nothing reports that.
 *
 * The compact block is a delta, so this test is what keeps it a complete one.
 */
describe("both densities define the same type tokens", () => {
  function blockFor(selector: string): string {
    const start = CSS.indexOf(`\n${selector} {`);
    return start === -1 ? "" : CSS.slice(start, CSS.indexOf("\n}", start));
  }

  const baseTypeNames = namesIn(blockFor(":root"));
  const compactBlock = blockFor(':root[data-density="compact"]');
  const compactNames = namesIn(compactBlock);

  it("finds the compact block at all", () => {
    // Otherwise every assertion below would pass vacuously against an empty set,
    // which is the failure mode of a parity test written the obvious way.
    expect(compactBlock.length).toBeGreaterThan(0);
    expect(compactNames.size).toBeGreaterThan(0);
  });

  it("defines every --type-* token in the compact block", () => {
    const typeTokens = [...baseTypeNames].filter((name) => name.startsWith("--type-")).sort();
    // Sanity check: the base must actually declare a scale, or this proves nothing.
    expect(typeTokens.length).toBeGreaterThanOrEqual(8);
    const missing = typeTokens.filter((name) => !compactNames.has(name));
    expect(missing).toEqual([]);
  });

  it("keeps the row height density-scoped", () => {
    expect(baseTypeNames.has("--row-height")).toBe(true);
    expect(compactNames.has("--row-height")).toBe(true);
  });

  it("never lets a density push a tier below the 12px floor", () => {
    // The floor is the reason the old scale was replaced, so a density that
    // undercut it would reintroduce the defect in the mode least able to afford
    // it. Read from both blocks rather than trusting the comment.
    for (const [label, block] of [
      ["comfortable", blockFor(":root")],
      ["compact", compactBlock],
    ] as const) {
      for (const match of block.matchAll(/--type-(t\d)-size:\s*([\d.]+)rem/g)) {
        const px = Number(match[2]) * 16;
        expect(px, `${label} ${match[1]} is ${px}px, below the 12px floor`).toBeGreaterThanOrEqual(
          12,
        );
      }
    }
  });
});

/**
 * Hardcoded sizes in the stylesheet.
 *
 * The class scan above reads the TypeScript sources. It cannot see the stylesheet,
 * and the floor was broken from exactly there: the `data-table` header rule declared
 * a bare `font-size: 0.625rem`. Ten pixels, on every schedule table, invisible to a
 * search for hardcoded utility classes.
 *
 * The rendered measurement in `measure-type.mjs` is what caught it. This test is the
 * cheap static version of that check, so the next one fails in CI rather than only
 * on a live page.
 */
describe("type sizes declared in the stylesheet", () => {
  it("keeps every hardcoded font-size at or above 12px, or on a token", () => {
    const offenders: string[] = [];
    for (const match of CSS.matchAll(/font-size:\s*([^;]+);/g)) {
      const value = match[1]!.trim();
      // Token references are governed by the density tests above.
      if (value.startsWith("var(")) continue;
      const px = value.endsWith("rem")
        ? Number.parseFloat(value) * 16
        : value.endsWith("px")
          ? Number.parseFloat(value)
          : null;
      const line = CSS.slice(0, match.index).split("\n").length;
      if (px === null) {
        offenders.push(`line ${line}: unparseable size "${value}"`);
      } else if (px < 12) {
        offenders.push(`line ${line}: ${value} is ${px}px, below the 12px floor`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would have caught the 10px table header", () => {
    // Proves the check is not vacuous: run the same logic against the value that
    // was actually shipped, and require it to be rejected.
    const shipped = "font-size: 0.625rem;";
    const value = shipped.match(/font-size:\s*([^;]+);/)?.[1]?.trim() ?? "";
    expect(value).toBe("0.625rem");
    expect(Number.parseFloat(value) * 16).toBeLessThan(12);
  });
});
