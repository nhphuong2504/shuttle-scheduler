import { describe, expect, it } from "vitest";

import { cn } from "../utils";

/**
 * `cn` has to treat the type tiers as font sizes, not colours.
 *
 * This file exists because it did not, and the failure was invisible. tailwind-merge
 * saw `text-t2` as an unrecognised word in the `text-` namespace, assumed it was a
 * text colour, and dropped it the moment a real colour class appeared beside it. The
 * class stayed in the source, vanished from the DOM, and the element fell back to an
 * inherited size - so nothing looked broken enough to investigate.
 *
 * The general lesson is worth stating: a design token is only real once something
 * has verified it survives the whole pipeline from class name to computed style. A
 * class in the source file proves nothing.
 */
describe("cn keeps the type tier alongside a colour", () => {
  it("retains the tier when a text colour follows it", () => {
    // The exact shape that used to fail: tier first, colour second.
    const merged = cn("font-score text-t2 uppercase", "bg-state-live-chip text-state-live-ink");
    expect(merged).toContain("text-t2");
    expect(merged).toContain("text-state-live-ink");
    expect(merged).toContain("bg-state-live-chip");
  });

  it("retains the tier when a text colour comes first", () => {
    // Order must not matter, or the bug would come back for anyone who reorders.
    const merged = cn("text-state-completed-ink", "font-score text-t2");
    expect(merged).toContain("text-t2");
    expect(merged).toContain("text-state-completed-ink");
  });

  it("keeps every tier, not just the one that was reported", () => {
    for (const tier of ["t1", "t2", "t3", "t4"]) {
      expect(cn(`text-${tier}`, "text-muted-foreground"), tier).toContain(`text-${tier}`);
    }
  });

  it("behaves like a known size, which is the standard it has to meet", () => {
    // `text-sm` was always fine; the tier must be indistinguishable in this respect.
    const builtin = cn("text-sm", "text-muted-foreground");
    const tier = cn("text-t4", "text-muted-foreground");
    expect(builtin).toContain("text-sm");
    expect(tier).toContain("text-t4");
  });

  it("still resolves genuine conflicts between two sizes", () => {
    // The extension must not disable merging itself: a real duplicate should still
    // collapse to the last one, and the tier is a size, so it wins over another size.
    expect(cn("text-t2", "text-t4")).toBe("text-t4");
    expect(cn("text-sm", "text-t2")).toBe("text-t2");
  });

  it("still resolves genuine conflicts between two colours", () => {
    // Guards against over-correcting by making text-* prefix-blind.
    expect(cn("text-primary", "text-muted-foreground")).toBe("text-muted-foreground");
  });
});
