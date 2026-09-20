// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatTile } from "@/components/app-shell";

/**
 * Layer 1 of the staff-surface strategy: component rendering.
 *
 * This file pins one rule found in phase 6, and it exists because the rule cannot be
 * fully covered by rendering the app. The rendered sweep in `e2e/states.spec.ts` only
 * ever measures the tiles the seeded desk happens to put on screen, so a tone that no
 * page currently uses - `danger`, today - would ship unchecked. Mounting the tile
 * covers all four tones at once, with no data and no credentials.
 *
 * The defect it pins: the label was `text-muted-foreground` on every tone. The neutral
 * ink is solved against the neutral surfaces, so on the warning surface in dark mode it
 * measured 3.95:1 against the 4.5:1 that 12px needs. It was invisible until phase 6
 * because a tournament with no matches in it renders no toned tile at all.
 */

afterEach(cleanup);

const TONES = ["normal", "good", "warn", "danger"] as const;

/** The tone's ink, as the design pairs it with that tone's surface. */
const TONE_INK: Record<(typeof TONES)[number], string> = {
  normal: "text-muted-foreground",
  good: "text-muted-foreground",
  warn: "text-warn-foreground",
  danger: "text-danger-foreground",
};

const labelOf = (container: HTMLElement): HTMLElement => {
  const label = container.querySelector("p");
  if (!label) throw new Error("the tile rendered no label");
  return label;
};

describe("a stat tile's label", () => {
  it("takes the ink its own surface was solved against", () => {
    for (const tone of TONES) {
      const { container } = render(<StatTile label="Courts waiting" value={2} tone={tone} />);
      const className = labelOf(container).className;
      expect(className, `the ${tone} tile lost its label ink`).toContain(TONE_INK[tone]);
      cleanup();
    }
  });

  it("never puts the neutral ink on a surface that is not neutral", () => {
    // The exact regression: a toned tile falling back to the chrome ink. Asserting the
    // absence matters as much as asserting the presence - a tile that carried both inks
    // would depend on CSS order to pick one, which is not a decision worth making twice.
    for (const tone of ["warn", "danger"] as const) {
      const { container } = render(<StatTile label="Ready, no court" value={3} tone={tone} />);
      expect(
        labelOf(container).className,
        `the ${tone} tile is carrying the neutral ink`,
      ).not.toContain("text-muted-foreground");
      cleanup();
    }
  });

  it("keeps the readout itself free of tone, so the number stays the loudest thing", () => {
    // The number is the value a moderator reads; the tone belongs to the label. This has
    // always been true and is asserted here so a colour fix cannot quietly tint the
    // readout at the same time.
    for (const tone of TONES) {
      const { container } = render(<StatTile label="Courts waiting" value={2} tone={tone} />);
      const readout = container.querySelectorAll("p")[1];
      expect(readout?.className, `the ${tone} tile tinted its readout`).not.toMatch(
        /text-(warn|danger|success|primary)-/,
      );
      cleanup();
    }
  });
});
