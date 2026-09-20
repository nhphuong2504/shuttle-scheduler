// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatusPill } from "@/components/app-shell";

/**
 * Layer 1 of the staff-surface strategy: component rendering.
 *
 * This file is the exemplar for the state matrix. It exists because the matrix is
 * not reachable by driving the app: every route renders for every visitor, and a
 * live tournament holds one status per match, so routing can only ever sample the
 * vocabulary. Mounting the component directly is the only way to cover every
 * permutation at once, and it needs no credentials, so it cannot rot when a
 * session expires.
 *
 * The surface tests in `src/routes/-surfaces.test.ts` read route sources with
 * regex, so they can assert that `StatusPill` is *called* but never what it
 * *renders*. These tests render it, which is the layer that can see the two
 * defects the design audit found in the shipped vocabulary:
 *
 *   - `void` is a persisted status with no label and no tier, so it renders
 *     indistinguishably from a typo.
 *   - tier 4 renders two different statuses through one shared ink.
 *
 * The second is now the intended design rather than a defect - the surplus tier-4
 * tokens were deleted in phase 1 - so it is pinned as a decision. The first is
 * still a defect. Both are pinned here as current behaviour rather than described
 * in a comment. Phase 5 rewrites them, and these expectations must change with it
 * - which is the point: the rewrite cannot happen silently.
 */

afterEach(cleanup);

const pill = (status: string) => {
  const { container } = render(<StatusPill status={status} />);
  return container.querySelector("span")!;
};

describe("StatusPill renders the tiered vocabulary", () => {
  it("renders tiers 1 to 3 as a chip with a fill, a border and a label", () => {
    const live = pill("in-progress");
    expect(live.textContent).toBe("Live");
    expect(live.className).toContain("rounded-full");
    expect(live.className).toContain("bg-state-live-chip");
    expect(live.className).toContain("text-state-live-ink");
    // Every state carries a glyph, so colour is never the only channel.
    expect(live.querySelector("svg")).not.toBeNull();
  });

  it("renders tier 4 as inline text, losing the container rather than the ink", () => {
    const completed = pill("reported");
    expect(completed.textContent).toBe("Completed");
    expect(completed.className).toContain("text-state-completed-ink");
    // No fill, no border, no radius: the archive states recede by dropping the
    // chip, because an ink light enough to recede would fail AA on a surface.
    expect(completed.className).not.toContain("rounded-full");
    expect(completed.className).not.toContain("bg-state-completed-chip");
    expect(completed.querySelector("svg")).not.toBeNull();
  });

  it("puts the status label on the identify tier in both branches", () => {
    // Pinned because it drifted once already: the component shipped at T4 while the
    // design canvas said T2, and no test noticed, because the assertions above check
    // structure and colour but never size. A status label is the primary operational
    // signal, so it is deliberately not the smallest text on screen - and since T2
    // is 13px in Compact, this is also what keeps a status out of the band where it
    // would compete with the 12px floor.
    expect(pill("in-progress").className).toContain("text-t2");
    expect(pill("reported").className).toContain("text-t2");
    expect(pill("something-new").className).toContain("text-t2");
    expect(pill("reported").className).not.toContain("text-t4");
  });

  it("pins the one persisted status with no token or tier", () => {
    // `void` is in the CHECK constraint on every match table but appears in no
    // map in this component, so it takes the same path as a typo: a neutral chip
    // carrying the raw string and a generic dot. It is not merely unstyled, it is
    // indistinguishable from an unrecognised value. Asserted so phase 5 has to
    // change it deliberately.
    const voided = pill("void");
    const unknown = pill("something-new");
    expect(voided.textContent).toBe("void");
    expect(voided.className).toContain("bg-muted");
    expect(voided.className).toContain("rounded-full");
    expect(voided.className).toBe(unknown.className);
  });

  it("keeps every archived status on the one shared tier-4 ink", () => {
    // The design decision, made executable. Both archived statuses render through
    // `state-completed-ink` and neither has an ink of its own: they are separated
    // by label and glyph, which is the redundant channel every state relies on.
    // The former assertion here pinned the opposite - that two tier-4 inks existed
    // and were never read. Those tokens are now deleted, so this pins the intent
    // rather than the defect.
    for (const status of ["reported", "walkover"]) {
      expect(pill(status).className).toContain("text-state-completed-ink");
    }
    expect(pill("reported").textContent).toBe("Completed");
    expect(pill("walkover").textContent).toBe("Walkover");
  });

  it("prints an unrecognised status rather than rendering nothing", () => {
    const unknown = pill("something-new");
    expect(unknown.textContent).toBe("something-new");
    expect(unknown.className).toContain("bg-muted");
  });
});
