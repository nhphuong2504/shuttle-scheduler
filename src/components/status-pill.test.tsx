// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ByeMarker, StatusPill } from "@/components/app-shell";
import {
  displayStateFor,
  MATCH_DISPLAY_LABEL,
  MATCH_DISPLAY_STATES,
  MATCH_DISPLAY_TIER,
  PERSISTED_MATCH_STATUSES,
  TIER4_DISPLAY_STATES,
} from "@/lib/tournament/match-status";

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
 * *renders*. These tests render it, which is the layer that can see the vocabulary
 * itself.
 *
 * Phase 5 rewrote this file's expectations. It previously pinned two defects as
 * current behaviour, so that a rewrite could not happen silently:
 *
 *   - `void` had no label and no tier, and rendered identically to a typo.
 *   - a bye was rendered as a match status - "Walkover" on one surface and
 *     "Completed" on another - when it is a draw condition.
 *
 * Both are fixed, so both are now asserted as *closed* rather than pinned. The
 * loop over `PERSISTED_MATCH_STATUSES` below is the guard that replaces them: it
 * is derived from the vocabulary rather than restating it, so a status added to
 * the schema without a label, a tier or a glyph fails here instead of shipping.
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
    // signal, so it is deliberately not the smallest text on screen. A status at T4
    // would sit in the band where it competes with the 12px floor.
    for (const status of PERSISTED_MATCH_STATUSES) {
      expect(pill(status).className).toContain("text-t2");
    }
    expect(pill("something-new").className).toContain("text-t2");
    expect(pill("reported").className).not.toContain("text-t4");
  });

  /**
   * The guard that replaced the pinned gap.
   *
   * Derived from `PERSISTED_MATCH_STATUSES`, so it cannot fall out of step with the
   * schema the way a hand-written list can. If a sixth status is ever permitted by
   * a migration and not added to the vocabulary, this loop renders nothing for it
   * and the assertions below fail - which is the point.
   */
  it("gives every persisted status a label, a tier and a glyph", () => {
    for (const status of PERSISTED_MATCH_STATUSES) {
      const display = displayStateFor(status);
      expect(display, `${status} has no display state`).not.toBeNull();
      if (!display) continue;

      expect(MATCH_DISPLAY_LABEL[display], `${status} has no label`).toBeTruthy();
      expect(MATCH_DISPLAY_TIER[display], `${status} has no tier`).toBeGreaterThanOrEqual(1);

      const rendered = pill(status);
      expect(rendered.textContent, `${status} label not rendered`).toBe(
        MATCH_DISPLAY_LABEL[display],
      );
      expect(rendered.querySelector("svg"), `${status} has no glyph`).not.toBeNull();
      // Not the fallback: an unplanned value prints its own raw string.
      expect(rendered.textContent).not.toBe(status);
    }
  });

  it("renders void as a neutral exception, not as an unrecognised value", () => {
    // The defect this phase fixes, asserted from the other side. `void` is in the
    // CHECK constraint on every match table, so it is a status the domain can hold;
    // it previously fell through to the same branch as a typo, showing the raw
    // string "void" in a muted chip with a generic dot.
    const voided = pill("void");
    const unknown = pill("something-new");

    expect(voided.textContent).toBe("Void");
    expect(voided.querySelector("svg")).not.toBeNull();
    expect(voided.className).toContain("rounded-full");
    // Its own tokens, so it is not the muted fallback...
    expect(voided.className).toContain("bg-state-void-chip");
    expect(voided.className).toContain("text-state-void-ink");
    expect(voided.className).not.toContain("bg-muted");
    // ...and demonstrably not the same element as an unrecognised value.
    expect(voided.className).not.toBe(unknown.className);

    // It is a chip, so it is not one of the ink-only archive states either.
    expect(voided.className).not.toContain("text-state-completed-ink");
  });

  it("marks void with a heavier ring than the other neutral chip", () => {
    // The channel that carries the exception. In dark mode the neutral ramp is too
    // compressed for a lightness step to separate void from scheduled - measured at
    // 7.2% of luminance against 14.2% in light - so the ring and the glyph are what
    // distinguish them, and this asserts the ring is actually there.
    expect(pill("void").className).toContain("ring-2");
    expect(pill("scheduled").className).not.toContain("ring-2");
  });

  it("keeps every archived status on the one shared tier-4 ink", () => {
    // The design decision, made executable. Both archived statuses render through
    // `state-completed-ink` and neither has an ink of its own: they are separated
    // by label and glyph, which is the redundant channel every state relies on.
    expect(TIER4_DISPLAY_STATES.slice().sort()).toEqual(["completed", "walkover"]);
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

  it("never presents a bye as a match status", () => {
    // The closed half of the bye defect. `bye` is permitted by two CHECK
    // constraints and written by nothing, and the vocabulary is a closed set of
    // five statuses that does not include it. If it ever reached the pill it would
    // be drawn as an unrecognised value, which is why it is routed to ByeMarker at
    // every render site instead - see `match-status.test.ts` for the predicate and
    // the surface tests for the call sites.
    expect(displayStateFor("bye")).toBeNull();
    expect(MATCH_DISPLAY_STATES).not.toContain("bye");
  });
});

describe("ByeMarker draws a draw condition, not a status", () => {
  it("is a chip without being a status chip", () => {
    const { container } = render(<ByeMarker />);
    const marker = container.querySelector("span")!;

    expect(marker.textContent).toBe("Bye");
    // Its own label, so it cannot be read as "Completed" or "Walkover".
    expect(marker.textContent).not.toBe("Completed");
    expect(marker.querySelector("svg")).not.toBeNull();

    // A dashed edge is the distinguishing treatment. It is the app's existing
    // vocabulary for "not a real thing", it needs no colour, and crucially it does
    // not reuse any state token - so a bye cannot be confused with a state.
    expect(marker.className).toContain("border-dashed");
    for (const display of MATCH_DISPLAY_STATES) {
      expect(marker.className).not.toContain(`state-${display}-`);
    }
  });

  it("advances rather than reusing the walkover glyph", () => {
    // The most confusable pair in the vocabulary, so they are asserted to differ.
    const { container: bye } = render(<ByeMarker />);
    const { container: walkover } = render(<StatusPill status="walkover" />);
    const byePaths = [...bye.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    const walkoverPaths = [...walkover.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    expect(byePaths).not.toEqual(walkoverPaths);
    expect(byePaths.length).toBeGreaterThan(0);
  });
});
